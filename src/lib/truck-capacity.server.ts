// Truck Capacity server helpers: forecast math, xlsx build & parse, P21 snapshot.
import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";

export const DEFAULT_P21_SQL = `-- Truck Capacity :: forward demand snapshot (STUB — admin must fill in).
-- Required output columns (exact names):
--   route_code        text     -- must match public.truck_capacity_routes.code
--   ship_date         date     -- shipment / delivery date
--   order_count       int
--   total_weight_lbs  numeric
--   total_cube_ft     numeric
--   est_pallets       numeric  -- server will compute projected_capacity_frac = min(1.5, est_pallets / pallets_full_truck)
--
-- Suggested (unverified) skeleton against P21 dbo:
--   SELECT ship_route AS route_code, CAST(promise_date AS DATE) AS ship_date,
--          COUNT(DISTINCT h.order_no) AS order_count,
--          SUM(l.extended_weight) AS total_weight_lbs,
--          SUM(l.extended_cube)   AS total_cube_ft,
--          SUM(l.extended_pallets) AS est_pallets
--   FROM dbo.oe_hdr h JOIN dbo.oe_line l ON l.order_no = h.order_no
--   WHERE h.completed = 'N' AND h.cancel_flag = 'N'
--     AND h.promise_date BETWEEN GETDATE() AND DATEADD(day, 28, GETDATE())
--   GROUP BY ship_route, CAST(promise_date AS DATE);
SELECT CAST(NULL AS varchar(32)) AS route_code,
       CAST(NULL AS date)        AS ship_date,
       CAST(NULL AS int)         AS order_count,
       CAST(NULL AS decimal(18,2)) AS total_weight_lbs,
       CAST(NULL AS decimal(18,2)) AS total_cube_ft,
       CAST(NULL AS decimal(18,2)) AS est_pallets
WHERE 1 = 0;`;

export type Route = {
  id: string; code: string; name: string; hub: string; sort_order: number;
  active: boolean; has_vendor_pickup: boolean; truck_type: string | null;
  pallets_full_truck: number | null; typical_dow: number[] | null;
  ship_to_zip_prefixes: string[] | null;
};

export type Run = {
  id: string; route_id: string; run_date: string; run_seq: number;
  capacity_frac: number; vendor_pickup_frac: number | null;
  driver: string | null; pallet_count: number | null; returned_pallets: number | null;
  notes: string | null; source: string;
};

/* ============================== FORECAST MATH ============================== */

export const FORECAST_METHOD_DESCRIPTION = `
For each route we look back 84 days (12 weeks) and identify the weekdays the route typically runs.
For each future day in the horizon that falls on one of those weekdays, we compute:
  • baseline = trimmed mean of capacity_frac for that (route, weekday) over the last 56 days
    (drop top/bottom 10%). If the route has fewer than 3 samples we fall back to the route mean,
    then to the hub mean, then to 0.5.
  • month factor  = shrunk (n·raw + 4) / (n + 4) where raw = mean(current month) / mean(all months).
  • forecast      = clamp(baseline × month_factor, 0, 1.25).
  • ±1 MAD band around the trailing window.
  • P21 overlay: if a snapshot row exists for that date, projected_capacity_frac is plotted alongside.
  • final line   = max(statistical forecast, P21 projection).
Hover a point to see the explain string, e.g. "Thu baseline 0.72 (n=7) × Jul 0.94 = 0.68".
Runs / forecasts ≥ 0.90 are flagged as at-capacity (second-truck risk). ≤ 0.30 as consolidation candidate.
`.trim();

export const FLAG_AT_CAPACITY = 0.9;
export const FLAG_CONSOLIDATION = 0.3;

function trimmedMean(nums: number[], trimPct = 0.1): number | null {
  if (nums.length === 0) return null;
  if (nums.length < 3) return nums.reduce((a, b) => a + b, 0) / nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * trimPct);
  const kept = sorted.slice(drop, sorted.length - drop);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function mad(nums: number[]): number {
  if (nums.length === 0) return 0;
  const m = mean(nums)!;
  const abs = nums.map((n) => Math.abs(n - m));
  return mean(abs)!;
}

function addDaysISO(iso: string, d: number): string {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function dowOf(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

function monthOf(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCMonth() + 1;
}

export type ForecastDay = {
  date: string; dow: number;
  baseline: number | null; seasonal: number; forecast: number | null;
  mad: number; p21: number | null; final: number | null;
  n_baseline: number; explain: string;
};

export async function computeForecastForRoute(routeId: string, horizonDays = 28): Promise<{
  route: Route | null; days: ForecastDay[];
}> {
  const { data: route } = await supabaseAdmin
    .from("truck_capacity_routes").select("*").eq("id", routeId).maybeSingle();
  if (!route) return { route: null, days: [] };

  const today = todayISO();
  const from = addDaysISO(today, -84);

  const { data: runsRaw } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("run_date, capacity_frac")
    .eq("route_id", routeId)
    .gte("run_date", from)
    .order("run_date", { ascending: true })
    .limit(2000);
  const runs = (runsRaw ?? []).map((r) => ({ date: r.run_date, cap: Number(r.capacity_frac) }));

  // Hub-mean fallback: pool other routes in same hub over same window
  const { data: hubRuns } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("capacity_frac, truck_capacity_routes!inner(hub)")
    .gte("run_date", from)
    .eq("truck_capacity_routes.hub", route.hub)
    .limit(5000);
  const hubMean = mean((hubRuns ?? []).map((r: any) => Number(r.capacity_frac))) ?? 0.5;

  // Weekday histogram — last 84 days
  const dowHist = new Map<number, number>();
  for (const r of runs) dowHist.set(dowOf(r.date), (dowHist.get(dowOf(r.date)) ?? 0) + 1);
  const activeDows = new Set<number>();
  for (const [d, n] of dowHist) if (n >= 2) activeDows.add(d);
  if (activeDows.size === 0) (route.typical_dow ?? []).forEach((d) => activeDows.add(d));

  // Baseline per weekday over last 56 days
  const cutoff56 = addDaysISO(today, -56);
  const byDow = new Map<number, number[]>();
  const routeValsAll: number[] = [];
  for (const r of runs) {
    if (r.date < cutoff56) continue;
    routeValsAll.push(r.cap);
    const d = dowOf(r.date);
    const arr = byDow.get(d) ?? [];
    arr.push(r.cap);
    byDow.set(d, arr);
  }
  const routeMean = mean(routeValsAll);
  const overallMean = mean(runs.map((r) => r.cap));

  // Monthly factor: raw = mean(this month) / mean(all), shrunk (n*raw + 4)/(n+4)
  const monthNow = monthOf(today);
  const thisMonthVals = runs.filter((r) => monthOf(r.date) === monthNow).map((r) => r.cap);
  const rawMonth = overallMean && overallMean > 0 && thisMonthVals.length > 0
    ? (mean(thisMonthVals)! / overallMean)
    : 1.0;
  const nMonth = thisMonthVals.length;
  const seasonal = (nMonth * rawMonth + 4 * 1.0) / (nMonth + 4);

  // P21 snapshot for horizon
  const horizonEnd = addDaysISO(today, horizonDays);
  const { data: p21Rows } = await supabaseAdmin
    .from("truck_capacity_p21_demand")
    .select("ship_date, projected_capacity_frac, snapshot_at")
    .eq("route_id", routeId)
    .gte("ship_date", today)
    .lte("ship_date", horizonEnd)
    .order("snapshot_at", { ascending: false });
  const p21Latest = new Map<string, number>();
  for (const p of p21Rows ?? []) {
    if (!p21Latest.has(p.ship_date)) p21Latest.set(p.ship_date, Number(p.projected_capacity_frac ?? 0));
  }

  const madVal = mad(routeValsAll);

  const days: ForecastDay[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const date = addDaysISO(today, i);
    const dw = dowOf(date);
    const p21 = p21Latest.has(date) ? p21Latest.get(date)! : null;
    if (!activeDows.has(dw)) {
      if (p21 != null && p21 > 0) {
        days.push({
          date, dow: dw, baseline: null, seasonal, forecast: null,
          mad: madVal, p21, final: p21, n_baseline: 0,
          explain: `No baseline (route does not typically run this weekday). P21 = ${p21.toFixed(2)}.`,
        });
      }
      continue;
    }
    const samples = byDow.get(dw) ?? [];
    const base = trimmedMean(samples) ?? routeMean ?? hubMean ?? 0.5;
    const forecast = Math.max(0, Math.min(1.25, base * seasonal));
    const final = p21 != null ? Math.max(forecast, p21) : forecast;
    const wk = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dw];
    const monLbl = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][monthOf(date) - 1];
    days.push({
      date, dow: dw,
      baseline: base, seasonal, forecast, mad: madVal, p21, final,
      n_baseline: samples.length,
      explain: `${wk} baseline ${base.toFixed(2)} (n=${samples.length}) × ${monLbl} ${seasonal.toFixed(2)} = ${forecast.toFixed(2)}${p21 != null ? ` · P21 ${p21.toFixed(2)}` : ""}`,
    });
  }

  return { route: route as Route, days };
}

/* ============================== P21 SNAPSHOT ============================== */

export async function runP21Snapshot(timeoutMs = 90_000): Promise<{
  rowsPulled: number; snapshotsWritten: number; unmatchedRouteCodes: string[]; skipped: boolean;
}> {
  const { data: settings } = await supabaseAdmin
    .from("truck_capacity_settings").select("p21_sql").eq("singleton", true).maybeSingle();
  const sqlText = (settings?.p21_sql ?? "").trim() || DEFAULT_P21_SQL;

  const { data: routes } = await supabaseAdmin
    .from("truck_capacity_routes").select("id, code, pallets_full_truck");
  const codeToRoute = new Map((routes ?? []).map((r) => [r.code.toLowerCase(), r]));

  let rows: any[] = [];
  try {
    const { result } = await runJob("sql.select", { sql: sqlText, params: {}, slug: "truck-capacity-p21" }, timeoutMs);
    rows = ((result as any)?.rows ?? []) as any[];
  } catch (e: any) {
    // If the stub is in place, this may simply return no rows — swallow rather than fail cron.
    if (/agent/i.test(String(e?.message ?? ""))) throw e;
    return { rowsPulled: 0, snapshotsWritten: 0, unmatchedRouteCodes: [], skipped: true };
  }

  if (rows.length === 0) return { rowsPulled: 0, snapshotsWritten: 0, unmatchedRouteCodes: [], skipped: false };

  const num = (v: any): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const iso = (v: any): string | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  const unmatched = new Set<string>();
  const inserts: any[] = [];
  for (const r of rows) {
    const code = String(r.route_code ?? "").trim();
    const ship = iso(r.ship_date);
    if (!code || !ship) continue;
    const route = codeToRoute.get(code.toLowerCase());
    if (!route) { unmatched.add(code); continue; }
    const est = num(r.est_pallets);
    const perTruck = route.pallets_full_truck ?? 18;
    const projected = est != null && perTruck > 0 ? Math.min(1.5, est / perTruck) : null;
    inserts.push({
      route_id: route.id,
      ship_date: ship,
      order_count: num(r.order_count),
      total_weight_lbs: num(r.total_weight_lbs),
      total_cube_ft: num(r.total_cube_ft),
      est_pallets: est,
      projected_capacity_frac: projected,
    });
  }

  let written = 0;
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("truck_capacity_p21_demand").insert(batch);
    if (error) throw new Error(`P21 snapshot insert failed: ${error.message}`);
    written += batch.length;
  }

  await supabaseAdmin.from("activity_events").insert({
    event_type: "truck_capacity.p21_snapshot",
    entity_type: "truck_capacity_p21_demand",
    message: `Truck Capacity P21 snapshot: ${written} rows, ${unmatched.size} unmatched route codes`,
    metadata: { written, unmatched: Array.from(unmatched) },
  });

  return { rowsPulled: rows.length, snapshotsWritten: written, unmatchedRouteCodes: Array.from(unmatched), skipped: false };
}

/* ============================== EXCEL EXPORT ============================== */

const HUB_ORDER = ["Dallas", "Birmingham", "Ocala"];
const VENDOR_PICKUP_CODES = new Set(["MOAR", "HOU", "WTN-LONG", "WTN-SHORT", "NGA", "SGA"]);

export async function exportCapacityWorkbook(): Promise<Buffer> {
  const { data: routes } = await supabaseAdmin
    .from("truck_capacity_routes").select("*").eq("active", true)
    .order("hub", { ascending: true }).order("sort_order", { ascending: true });

  const { data: runs } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("route_id, run_date, run_seq, capacity_frac, vendor_pickup_frac, driver, pallet_count, returned_pallets, notes")
    .order("run_date", { ascending: true })
    .limit(50000);
  const byRoute = new Map<string, any[]>();
  for (const r of runs ?? []) {
    const arr = byRoute.get(r.route_id) ?? [];
    arr.push(r);
    byRoute.set(r.route_id, arr);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "Nelson AI";
  wb.created = new Date();

  const sortedRoutes = [...(routes ?? [])].sort((a, b) => {
    const ha = HUB_ORDER.indexOf(a.hub); const hb = HUB_ORDER.indexOf(b.hub);
    if (ha !== hb) return ha - hb;
    return a.sort_order - b.sort_order;
  });

  for (const route of sortedRoutes) {
    const withVendor = VENDOR_PICKUP_CODES.has(route.code) || route.has_vendor_pickup;
    const headers = withVendor
      ? ["Date", "Capacity", "Unused Capacity", "Vendor Pickup Capacity", "Driver", "Pallet Count", "Notes", "Returned Pallets"]
      : ["Date", "Capacity", "Unused Capacity", "Driver", "Pallet Count", "Notes", "Returned Pallets"];
    const sheetName = route.name.replace(/[\\/*?:\[\]]/g, "").slice(0, 31) || route.code.slice(0, 31);
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const list = byRoute.get(route.id) ?? [];
    let rowIdx = 2;
    for (const r of list) {
      const dateLabel = r.run_seq && r.run_seq > 1 ? `${r.run_date} - Run ${r.run_seq}` : r.run_date;
      if (withVendor) {
        ws.addRow([dateLabel, Number(r.capacity_frac), { formula: `1-B${rowIdx}` }, r.vendor_pickup_frac != null ? Number(r.vendor_pickup_frac) : null, r.driver, r.pallet_count, r.notes, r.returned_pallets]);
      } else {
        ws.addRow([dateLabel, Number(r.capacity_frac), { formula: `1-B${rowIdx}` }, r.driver, r.pallet_count, r.notes, r.returned_pallets]);
      }
      const row = ws.getRow(rowIdx);
      row.getCell(2).numFmt = "0.00%";
      row.getCell(3).numFmt = "0.00%";
      if (withVendor) row.getCell(4).numFmt = "0.00%";
      rowIdx++;
    }
    ws.columns.forEach((c) => { c.width = 16; });
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

/* ============================== EXCEL IMPORT ============================== */

// Maps workbook sheet-name variants → route.code
const SHEET_TO_ROUTE_CODE: Record<string, string> = {
  "dallas special runs": "DAL-SPECIAL",
  "dallas-local": "DAL-LOCAL", "dallas local": "DAL-LOCAL",
  "moar": "MOAR", "east tx": "ETX",
  "okl": "OKL", "hou": "HOU", "kan": "KAN", "ark": "ARK",
  "bham transfer": "BHM-XFER-DAL", "bham transfer (dallas)": "BHM-XFER-DAL", "birmingham transfer": "BHM-XFER-DAL",
  "birmingham special runs": "BHM-SPECIAL",
  "mislou": "MISLOU", "sw miss": "SWMISS", "north al": "NAL", "north miss.": "NMISS", "north miss": "NMISS",
  "central al": "CAL", "mid tn": "MTN", "east tn": "ETN",
  "west tn - long": "WTN-LONG", "west tn long": "WTN-LONG",
  "west tn - short": "WTN-SHORT", "west tn short": "WTN-SHORT",
  "dallas transfer": "DAL-XFER-BHM", "dallas transfer (bham)": "DAL-XFER-BHM",
  "ocala transfer": "OCA-XFER-BHM", "ocala transfer (bham)": "OCA-XFER-BHM",
  "north ga": "NGA", "south ga": "SGA",
  "east carolina": "ECAR", "west carolina": "WCAR",
  "south al": "SAL", "gulf coast": "GULF",
  "ocala special runs": "OCA-SPECIAL",
  "jax": "JAX", "sefl": "SEFL", "mia": "MIA", "orl": "ORL", "swfl": "SWFL", "tampa": "TAMPA",
  // hidden legacy sheet — explicit skip
  "carolinas": "__SKIP__",
};

type ImportRow = {
  route_code: string;
  run_date: string;
  run_seq: number;
  capacity_frac: number;
  vendor_pickup_frac: number | null;
  driver: string | null;
  pallet_count: number | null;
  returned_pallets: number | null;
  notes: string | null;
};

type ImportReport = {
  sheets: Array<{
    sheet: string; route_code: string | null; status: "ok" | "unmapped" | "skipped";
    ok: number; skipped_bad_date: number; skipped_no_capacity: number; skipped_old_year: number;
  }>;
  rows: ImportRow[];
  totalOk: number;
};

function normHeader(s: any): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseDateCell(v: any): { iso: string | null; seq: number } {
  if (v == null || v === "") return { iso: null, seq: 1 };
  if (v instanceof Date) return { iso: v.toISOString().slice(0, 10), seq: 1 };
  if (typeof v === "number") {
    // Excel serial date
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? { iso: null, seq: 1 } : { iso: d.toISOString().slice(0, 10), seq: 1 };
  }
  const s = String(v);
  const m = s.match(/^(.+?)\s*[-–]\s*Run\s*(\d+)\s*$/i);
  const datePart = m ? m[1] : s;
  const seq = m ? Number(m[2]) : 1;
  const d = new Date(datePart);
  if (Number.isNaN(d.getTime())) return { iso: null, seq };
  return { iso: d.toISOString().slice(0, 10), seq };
}

function toNum(v: any): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "object" && "result" in v) v = (v as any).result;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[%\s]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // If workbook expressed as percentage 45 → 0.45
  return String(v).includes("%") ? n / 100 : n;
}

export async function parseImportWorkbook(fileBase64: string): Promise<ImportReport> {
  const buf = Buffer.from(fileBase64, "base64");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);

  const { data: routes } = await supabaseAdmin.from("truck_capacity_routes").select("code");
  const validCodes = new Set((routes ?? []).map((r) => r.code));

  const report: ImportReport = { sheets: [], rows: [], totalOk: 0 };

  wb.eachSheet((ws) => {
    const key = normHeader(ws.name);
    const routeCode = SHEET_TO_ROUTE_CODE[key];
    const sheetOut = {
      sheet: ws.name, route_code: routeCode === "__SKIP__" ? null : (routeCode ?? null),
      status: "ok" as "ok" | "unmapped" | "skipped",
      ok: 0, skipped_bad_date: 0, skipped_no_capacity: 0, skipped_old_year: 0,
    };
    if (!routeCode) { sheetOut.status = "unmapped"; report.sheets.push(sheetOut); return; }
    if (routeCode === "__SKIP__") { sheetOut.status = "skipped"; report.sheets.push(sheetOut); return; }
    if (!validCodes.has(routeCode)) { sheetOut.status = "unmapped"; report.sheets.push(sheetOut); return; }

    const headerRow = ws.getRow(1);
    const headers: Record<string, number> = {};
    headerRow.eachCell((cell, col) => { headers[normHeader(cell.value)] = col; });
    const colDate = headers["date"];
    const colCap = headers["capacity"];
    const colVendor = headers["vendor pickup capacity"];
    const colDriver = headers["driver"];
    const colPallets = headers["pallet count"];
    const colNotes = headers["notes"];
    const colReturned = headers["returned pallets"];
    if (!colDate || !colCap) { sheetOut.status = "unmapped"; report.sheets.push(sheetOut); return; }

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rawDate = row.getCell(colDate).value;
      const { iso, seq } = parseDateCell(rawDate);
      if (!iso) { if (rawDate != null && rawDate !== "") sheetOut.skipped_bad_date++; continue; }
      if (Number(iso.slice(0, 4)) < 2020) { sheetOut.skipped_old_year++; continue; }
      const cap = toNum(row.getCell(colCap).value);
      if (cap == null) { sheetOut.skipped_no_capacity++; continue; }
      const capClamped = Math.max(0, Math.min(1.25, cap));
      report.rows.push({
        route_code: routeCode,
        run_date: iso,
        run_seq: Math.max(1, Math.floor(seq)),
        capacity_frac: capClamped,
        vendor_pickup_frac: colVendor ? (() => { const n = toNum(row.getCell(colVendor).value); return n == null ? null : Math.max(0, Math.min(1.25, n)); })() : null,
        driver: colDriver ? (row.getCell(colDriver).value ? String(row.getCell(colDriver).value) : null) : null,
        pallet_count: colPallets ? (toNum(row.getCell(colPallets).value)) as any : null,
        returned_pallets: colReturned ? (toNum(row.getCell(colReturned).value)) as any : null,
        notes: colNotes ? (row.getCell(colNotes).value ? String(row.getCell(colNotes).value) : null) : null,
      });
      sheetOut.ok++;
    }
    report.totalOk += sheetOut.ok;
    report.sheets.push(sheetOut);
  });

  return report;
}

export async function applyImportRows(rows: ImportRow[]): Promise<{ inserted: number }> {
  if (rows.length === 0) return { inserted: 0 };
  const { data: routes } = await supabaseAdmin.from("truck_capacity_routes").select("id, code");
  const codeToId = new Map((routes ?? []).map((r) => [r.code, r.id]));
  const inserts = rows
    .filter((r) => codeToId.has(r.route_code))
    .map((r) => ({
      route_id: codeToId.get(r.route_code)!,
      run_date: r.run_date, run_seq: r.run_seq,
      capacity_frac: r.capacity_frac, vendor_pickup_frac: r.vendor_pickup_frac,
      driver: r.driver, pallet_count: r.pallet_count, returned_pallets: r.returned_pallets,
      notes: r.notes, source: "import",
    }));
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("truck_capacity_runs")
      .upsert(batch, { onConflict: "route_id,run_date,run_seq" });
    if (error) throw new Error(`Import upsert failed: ${error.message}`);
    inserted += batch.length;
  }
  return { inserted };
}
