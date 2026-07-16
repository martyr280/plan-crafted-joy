// Truck Capacity server helpers: forecast math, xlsx build & parse, P21 snapshot.
import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import { validateSelectSql } from "./sql-schedules.server";
import { baselineFromSnapshot, addDaysISO } from "./truck-capacity/baseline";

// Re-export serving forecast + trainer so consumers keep a single import path.
export { computeForecastForRoute } from "./truck-capacity/serve";
export type { ForecastDay, ForecastResponse, ServingMethod } from "./truck-capacity/serve";
export { trainAndMaybePromote } from "./truck-capacity/train";
export type { TrainSummary } from "./truck-capacity/train";


export const DEFAULT_P21_SQL = `-- Truck Capacity :: forward demand snapshot.
-- Required output columns (exact names):
--   route_code        text     -- matched against truck_capacity_routes.p21_route_code, then .code
--   ship_date         date     -- shipment / delivery date
--   order_count       int
--   total_weight_lbs  numeric
--   total_cube_ft     numeric
--   est_pallets       numeric  -- may be NULL; capacity ratio falls back to weight/cube when so
--
-- Optional output column:
--   ship_city         text     -- ship-to city on the order. When a P21 code is
--                                 claimed by more than one route (e.g. NSC01
--                                 covers both Carolinas), the server uses
--                                 ship_city to disambiguate — the row is
--                                 assigned to the claimant whose p21_cities
--                                 list contains this city (case-insensitive).
--                                 If ship_city is returned, the server also
--                                 re-aggregates rows to (route_id, ship_date)
--                                 before insert.
--
-- Schema confirmed by NDI (K. Moore, Jul 2026): the order-header route lives on
-- oe_hdr.shipping_route_uid → shipping_route.route_code (not a plain column on
-- oe_hdr). required_date is the field NDI uses ("date we start the shipping
-- process"); promise/requested get skewed by request delays. Weight/cube are on
-- inv_mast (im.weight, im.cube). Ship-to city is oe_hdr.ship2_city.
--
-- Filter convention (projected_order='N' = not a quote) mirrors the working
-- SPIFF query in this codebase. qty_ordered is used as the open-quantity proxy
-- for now — a net-of-shipped refinement is possible later.
--
-- Warehouse transfers live in transfer_hdr/transfer_line and are NOT covered by
-- this query; a phase-2 transfer-demand query will add BHM-XFER-DAL /
-- DAL-XFER-BHM / BHM-XFER-OCA once its columns are confirmed.
SELECT sr.route_code                    AS route_code,
       CAST(h.required_date AS DATE)    AS ship_date,
       h.ship2_city                     AS ship_city,
       COUNT(DISTINCT h.order_no)       AS order_count,
       SUM(l.qty_ordered * im.weight)   AS total_weight_lbs,
       SUM(l.qty_ordered * im.cube)     AS total_cube_ft,
       CAST(NULL AS decimal(18,2))      AS est_pallets
  FROM dbo.oe_hdr h
  JOIN dbo.shipping_route sr ON sr.shipping_route_uid = h.shipping_route_uid
  JOIN dbo.oe_line l  ON l.order_no = h.order_no
  JOIN dbo.inv_mast im ON im.inv_mast_uid = l.inv_mast_uid
 WHERE h.completed = 'N'
   AND ISNULL(h.cancel_flag, 'N') = 'N'
   AND ISNULL(h.delete_flag, 'N') = 'N'
   AND ISNULL(h.projected_order, 'N') = 'N'
   AND l.delete_flag = 'N'
   AND h.required_date BETWEEN CAST(GETDATE() AS DATE) AND DATEADD(day, 28, CAST(GETDATE() AS DATE))
 GROUP BY sr.route_code, CAST(h.required_date AS DATE), h.ship2_city;`;


// (Route / Run types defined below alongside the forecast helper.)


/* ============================== FORECAST DESCRIPTION ============================== */

export const FORECAST_METHOD_DESCRIPTION = `
Two layers, blended:
  1. Baseline (statistical): the last-12-weeks weekday pattern × trimmed-mean baseline
     per (route, weekday) over 56 days, times a shrunk monthly seasonal factor. Fallback
     chain is route → hub → 0.5. This is the same explain string you see today:
       "Thu baseline 0.72 (n=7) × Jul 0.94 = 0.68".
  2. Model (ridge regression): a small L2 model trained on the entire run history.
     Features cover weekday, month, hub, truck type, trend, and lag signals
     (EW-mean halflife=5, last run, same-weekday lag, overall mean, run count,
     missing-history flag, hub trailing 28d). Coefficients are additive so we surface
     per-day drivers like "recent form +0.09, Friday +0.06, July +0.03".

Serving pick:
  • final = clamp(w · model + (1 − w) · baseline, 0, 1.25) with (λ, w) chosen on a
    rolling-origin backtest (monthly cutoffs, 28-day horizon). Grid: λ ∈ {0.3,1,3,10,30,100},
    w ∈ {0, 0.3, 0.5, 0.7, 1.0}.
  • Promotion gate: the blend only becomes the serving default if its holdout MAE beats
    baseline; otherwise baseline stays default and the model is available as a toggle.
  • P21 max-guard: if the open-order snapshot for a date exceeds the blend, final = P21.
    Excluded from MAE math.
  • Uncertainty band: ±1 MAD per-route residual from the latest promoted backtest;
    falls back to the trailing-window MAD when a route has no residuals yet.

Runs / forecasts ≥ 0.90 are flagged as at-capacity (second-truck risk). ≤ 0.30 as consolidation candidate.
`.trim();

export const FLAG_AT_CAPACITY = 0.9;
export const FLAG_CONSOLIDATION = 0.3;

export type Route = {
  id: string; code: string; name: string; hub: string; sort_order: number;
  active: boolean; has_vendor_pickup: boolean; truck_type: string | null;
  pallets_full_truck: number | null; typical_dow: number[] | null;
  ship_to_zip_prefixes: string[] | null;
  p21_route_code: string | null; cutoff_time: string | null;
  cube_full_truck_ft3: number | null; weight_full_truck_lbs: number | null;
  p21_cities: string[] | null;
};


export type Run = {
  id: string; route_id: string; run_date: string; run_seq: number;
  capacity_frac: number; vendor_pickup_frac: number | null;
  driver: string | null; pallet_count: number | null; returned_pallets: number | null;
  notes: string | null; source: string;
};

/**
 * Baseline-only forecast helper (no model, no P21 max-guard). Kept for callers
 * that specifically want the historical trimmed-mean × seasonal output.
 * The full serving path lives in `truck-capacity/serve.ts` and is re-exported
 * as `computeForecastForRoute` at the top of this file.
 */
export async function computeBaselineForecastForRoute(routeId: string, horizonDays = 28) {
  const { data: route } = await supabaseAdmin
    .from("truck_capacity_routes").select("*").eq("id", routeId).maybeSingle();
  if (!route) return { route: null, days: [] };
  const today = new Date().toISOString().slice(0, 10);
  const from = addDaysISO(today, -84);
  const { data: runsRaw } = await supabaseAdmin
    .from("truck_capacity_runs").select("run_date, capacity_frac")
    .eq("route_id", routeId).gte("run_date", from)
    .order("run_date", { ascending: true }).limit(3000);
  const routeRuns = (runsRaw ?? []).map((r) => ({ date: r.run_date, cap: Number(r.capacity_frac) }));
  const { data: hubRuns } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("capacity_frac, truck_capacity_routes!inner(hub)")
    .gte("run_date", from).eq("truck_capacity_routes.hub", route.hub).limit(20000);
  const days = baselineFromSnapshot(
    routeRuns, (hubRuns ?? []).map((r: any) => Number(r.capacity_frac)),
    today, horizonDays, route.typical_dow ?? [],
  );
  return { route, days };
}


/* ============================== P21 SNAPSHOT ============================== */

export async function runP21Snapshot(timeoutMs = 90_000): Promise<{
  ok: boolean; rowsPulled: number; snapshotsWritten: number;
  unmatchedRouteCodes: string[]; skipped: boolean; error?: string;
}> {
  const { data: settings } = await supabaseAdmin
    .from("truck_capacity_settings").select("p21_sql").eq("singleton", true).maybeSingle();
  const sqlText = (settings?.p21_sql ?? "").trim() || DEFAULT_P21_SQL;

  // Defense-in-depth: reject anything that isn't a read-only SELECT/WITH/DECLARE
  // before it goes to the bridge, even though the DB user is db_datareader-only.
  try {
    validateSelectSql(sqlText);
  } catch (e: any) {
    const error = e?.message ?? String(e);
    await supabaseAdmin.from("activity_events").insert({
      event_type: "truck_capacity.snapshot_failed",
      entity_type: "truck_capacity_p21_demand",
      message: `Truck Capacity P21 snapshot rejected: ${error}`,
      metadata: { stage: "validate" },
    });
    return { ok: false, rowsPulled: 0, snapshotsWritten: 0, unmatchedRouteCodes: [], skipped: false, error };
  }

  const { data: routes } = await supabaseAdmin
    .from("truck_capacity_routes")
    .select("id, code, p21_route_code, p21_cities, typical_dow, sort_order, pallets_full_truck, cube_full_truck_ft3, weight_full_truck_lbs");

  // Build code → claimants[] map. p21_route_code may be a comma-separated list
  // (e.g. "ARK01,ARK02"), and a single P21 code may legitimately be claimed
  // by more than one internal route (e.g. NSC01 covers both Carolinas,
  // GEO02 covers both N and S Georgia via different weekday cutoffs).
  // Priority: p21_route_code entries win over .code fallback. Per-row
  // resolution happens below; we only record all claimants here.
  const codeToRoutes = new Map<string, Array<any>>();
  const addClaim = (rawCode: string, r: any, priority: number) => {
    const key = rawCode.trim().toLowerCase();
    if (!key) return;
    const arr = codeToRoutes.get(key) ?? [];
    arr.push({ ...r, _priority: priority });
    codeToRoutes.set(key, arr);
  };
  // Fallback first (lower priority) so p21 entries take precedence.
  for (const r of routes ?? []) if (r.code) addClaim(String(r.code), r, 0);
  for (const r of routes ?? []) {
    if (!r.p21_route_code) continue;
    for (const part of String(r.p21_route_code).split(",")) addClaim(part, r, 1);
  }
  // Keep only the highest-priority claimants per code (drops the .code
  // fallback when the same code is also listed as a real p21_route_code
  // on another route).
  for (const [key, arr] of codeToRoutes) {
    const maxP = Math.max(...arr.map((x) => x._priority));
    codeToRoutes.set(key, arr.filter((x) => x._priority === maxP));
  }


  let rows: any[] = [];
  try {
    const { result } = await runJob("sql.select", { sql: sqlText, params: {}, slug: "truck-capacity-p21" }, timeoutMs);
    rows = ((result as any)?.rows ?? []) as any[];
  } catch (e: any) {
    const error = e?.message ?? String(e);
    await supabaseAdmin.from("activity_events").insert({
      event_type: "truck_capacity.snapshot_failed",
      entity_type: "truck_capacity_p21_demand",
      message: `Truck Capacity P21 snapshot failed: ${error}`,
      metadata: { stage: "execute" },
    });
    return { ok: false, rowsPulled: 0, snapshotsWritten: 0, unmatchedRouteCodes: [], skipped: false, error };
  }

  // Zero rows against a well-formed query (e.g. the WHERE 1=0 stub) is a valid
  // no-op, not an error.
  if (rows.length === 0) {
    return { ok: true, rowsPulled: 0, snapshotsWritten: 0, unmatchedRouteCodes: [], skipped: true };
  }

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
  // City normalizer: drop leading/trailing whitespace and any trailing state
  // token (", TX" / "TX" — some P21 exports append the state to the city).
  const normCity = (v: any): string | null => {
    if (v == null) return null;
    let s = String(v).trim();
    if (!s) return null;
    // Strip trailing ", XX" (2-letter state) or trailing " XX".
    s = s.replace(/[,\s]+[A-Za-z]{2}\s*$/, "");
    return s.trim().toLowerCase();
  };

  // Per-row resolution — see the DEFAULT_P21_SQL header comment for the
  // full contract. Order: single-claimant → city match → weekday match →
  // sort_order tiebreaker (plus one ambiguity warning per snapshot).
  const unmatched = new Set<string>();
  const ambiguousResolved = new Map<string, { kept: string[]; dropped: string[] }>();
  // Aggregate to (route_id, ship_date) — an optional ship_city column can
  // produce many rows per route/date that must be summed before insert.
  const agg = new Map<string, {
    route_id: string; ship_date: string;
    order_count: number; total_weight_lbs: number | null;
    total_cube_ft: number | null; est_pallets: number | null;
    // per-route full-truck targets kept so we can recompute the projected ratio after aggregation
    pallets_full_truck: number | null; cube_full_truck_ft3: number | null; weight_full_truck_lbs: number | null;
  }>();
  const addNullable = (a: number | null, b: number | null): number | null =>
    a == null && b == null ? null : (a ?? 0) + (b ?? 0);

  for (const r of rows) {
    const code = String(r.route_code ?? "").trim();
    const ship = iso(r.ship_date);
    if (!code || !ship) continue;
    const claimants = codeToRoutes.get(code.toLowerCase());
    if (!claimants || claimants.length === 0) { unmatched.add(code); continue; }

    let route: any;
    if (claimants.length === 1) {
      route = claimants[0];
    } else {
      // (b) city match
      const city = normCity(r.ship_city);
      const cityHits = city
        ? claimants.filter((c) => Array.isArray(c.p21_cities)
            && c.p21_cities.some((x: string) => normCity(x) === city))
        : [];
      if (cityHits.length === 1) {
        route = cityHits[0];
      } else {
        // (c) weekday match
        const dow = new Date(ship + "T00:00:00Z").getUTCDay();
        const dowHits = claimants.filter((c) => Array.isArray(c.typical_dow)
          && c.typical_dow.includes(dow));
        if (dowHits.length === 1) {
          route = dowHits[0];
        } else {
          // (d) sort_order tiebreaker
          const sorted = [...claimants].sort((a, b) =>
            (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY));
          route = sorted[0];
          const entry = ambiguousResolved.get(code) ?? { kept: [], dropped: [] };
          if (!entry.kept.includes(route.code)) entry.kept.push(route.code);
          for (const c of sorted.slice(1)) if (!entry.dropped.includes(c.code)) entry.dropped.push(c.code);
          ambiguousResolved.set(code, entry);
        }
      }
    }

    const est = num(r.est_pallets);
    const weight = num(r.total_weight_lbs);
    const cube = num(r.total_cube_ft);
    const oc = num(r.order_count) ?? 0;
    const key = `${route.id}|${ship}`;
    const prev = agg.get(key);
    if (prev) {
      prev.order_count += oc;
      prev.total_weight_lbs = addNullable(prev.total_weight_lbs, weight);
      prev.total_cube_ft = addNullable(prev.total_cube_ft, cube);
      prev.est_pallets = addNullable(prev.est_pallets, est);
    } else {
      agg.set(key, {
        route_id: route.id, ship_date: ship,
        order_count: oc, total_weight_lbs: weight,
        total_cube_ft: cube, est_pallets: est,
        pallets_full_truck: route.pallets_full_truck,
        cube_full_truck_ft3: route.cube_full_truck_ft3 == null ? null : Number(route.cube_full_truck_ft3),
        weight_full_truck_lbs: route.weight_full_truck_lbs == null ? null : Number(route.weight_full_truck_lbs),
      });
    }
  }

  if (ambiguousResolved.size > 0) {
    const collisions = Array.from(ambiguousResolved.entries()).map(([code, v]) => ({
      code, kept: v.kept, dropped: v.dropped,
    }));
    await supabaseAdmin.from("activity_events").insert({
      event_type: "truck_capacity.route_code_ambiguous",
      entity_type: "truck_capacity_routes",
      message: `Truck Capacity: ${collisions.length} P21 route code(s) could not be resolved by city or weekday — fell back to lowest sort_order.`,
      metadata: { collisions },
    });
  }

  const inserts: any[] = [];
  for (const a of agg.values()) {
    const ratios: number[] = [];
    if (a.est_pallets != null && a.pallets_full_truck && a.pallets_full_truck > 0) {
      ratios.push(a.est_pallets / a.pallets_full_truck);
    }
    if (a.total_cube_ft != null && a.cube_full_truck_ft3 && a.cube_full_truck_ft3 > 0) {
      ratios.push(a.total_cube_ft / a.cube_full_truck_ft3);
    }
    if (a.total_weight_lbs != null && a.weight_full_truck_lbs && a.weight_full_truck_lbs > 0) {
      ratios.push(a.total_weight_lbs / a.weight_full_truck_lbs);
    }
    if (ratios.length === 0) continue;
    inserts.push({
      route_id: a.route_id,
      ship_date: a.ship_date,
      order_count: a.order_count,
      total_weight_lbs: a.total_weight_lbs,
      total_cube_ft: a.total_cube_ft,
      est_pallets: a.est_pallets,
      projected_capacity_frac: Math.min(1.5, Math.max(...ratios)),
    });
  }


  let written = 0;
  try {
    for (let i = 0; i < inserts.length; i += 500) {
      const batch = inserts.slice(i, i + 500);
      const { error } = await supabaseAdmin.from("truck_capacity_p21_demand").insert(batch);
      if (error) throw new Error(`P21 snapshot insert failed: ${error.message}`);
      written += batch.length;
    }
  } catch (e: any) {
    const error = e?.message ?? String(e);
    await supabaseAdmin.from("activity_events").insert({
      event_type: "truck_capacity.snapshot_failed",
      entity_type: "truck_capacity_p21_demand",
      message: `Truck Capacity P21 snapshot insert failed: ${error}`,
      metadata: { stage: "insert", written },
    });
    return { ok: false, rowsPulled: rows.length, snapshotsWritten: written, unmatchedRouteCodes: Array.from(unmatched), skipped: false, error };
  }

  await supabaseAdmin.from("activity_events").insert({
    event_type: "truck_capacity.p21_snapshot",
    entity_type: "truck_capacity_p21_demand",
    message: `Truck Capacity P21 snapshot: ${written} rows, ${unmatched.size} unmatched route codes`,
    metadata: { written, unmatched: Array.from(unmatched) },
  });

  return { ok: true, rowsPulled: rows.length, snapshotsWritten: written, unmatchedRouteCodes: Array.from(unmatched), skipped: false };
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

// Sheet map imported from single source of truth to keep server + seed script in sync.
import { SHEET_TO_ROUTE_CODE } from "./truck-capacity/sheet-map";

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
  if (v instanceof Date) {
    // Use UTC parts to avoid TZ shifts.
    const y = v.getUTCFullYear(), mo = v.getUTCMonth() + 1, dd = v.getUTCDate();
    return { iso: `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, seq: 1 };
  }
  if (typeof v === "number") {
    // Excel serial date → UTC ymd (no TZ shift).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { iso: null, seq: 1 };
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, dd = d.getUTCDate();
    return { iso: `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, seq: 1 };
  }
  const s = String(v);
  const m = s.match(/^(.+?)\s*[-–]\s*Run\s*(\d+)\s*$/i);
  const datePart = (m ? m[1] : s).trim();
  const seq = m ? Number(m[2]) : 1;

  // Explicit M/D/YYYY or M-D-YYYY → build YYYY-MM-DD without new Date() (avoids TZ shifts).
  const mdy = datePart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    let [, mo, dd, yy] = mdy;
    let year = Number(yy);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const mm = Number(mo), d = Number(dd);
    if (mm >= 1 && mm <= 12 && d >= 1 && d <= 31) {
      return { iso: `${year}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`, seq };
    }
  }
  // ISO YYYY-MM-DD passthrough.
  const isoMatch = datePart.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return { iso: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`, seq };

  const d = new Date(datePart);
  if (Number.isNaN(d.getTime())) return { iso: null, seq };
  const y = d.getUTCFullYear(), mo2 = d.getUTCMonth() + 1, dd2 = d.getUTCDate();
  return { iso: `${y}-${String(mo2).padStart(2, "0")}-${String(dd2).padStart(2, "0")}`, seq };
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
      const y = Number(iso.slice(0, 4));
      if (!(y >= 2020 && y <= 2100)) { sheetOut.skipped_old_year++; continue; }
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
        pallet_count: colPallets ? (() => { const n = toNum(row.getCell(colPallets).value); return n == null ? null : Math.round(n); })() : null,
        returned_pallets: colReturned ? (() => { const n = toNum(row.getCell(colReturned).value); return n == null ? null : Math.round(n); })() : null,

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
