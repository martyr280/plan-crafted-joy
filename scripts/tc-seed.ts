// Seed script: parse client workbook, upsert into truck_capacity_runs via psql.
// Run with: bun run scripts/tc-seed.ts <xlsx-path>

import ExcelJS from "exceljs";
import { execSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  "carolinas": "__SKIP__",
};

const normHeader = (s: any) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function parseDateCell(v: any): { iso: string | null; seq: number } {
  if (v == null || v === "") return { iso: null, seq: 1 };
  if (v instanceof Date) {
    const y = v.getUTCFullYear(), mo = v.getUTCMonth() + 1, dd = v.getUTCDate();
    return { iso: `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, seq: 1 };
  }
  if (typeof v === "number") {
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
  const mdy = datePart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (mdy) {
    let [, mo, dd, yy] = mdy;
    let year = Number(yy);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    const mm = Number(mo), d = Number(dd);
    if (mm >= 1 && mm <= 12 && d >= 1 && d <= 31)
      return { iso: `${year}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`, seq };
  }
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
  return String(v).includes("%") ? n / 100 : n;
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("usage: bun run scripts/tc-seed.ts <xlsx>");
  const buf = readFileSync(path);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);

  // Fetch routes (code → id, hub)
  const routesJson = execSync(`psql -At -c "select json_agg(json_build_object('code',code,'id',id,'hub',hub)) from public.truck_capacity_routes"`).toString().trim();
  const routes = JSON.parse(routesJson) as Array<{ code: string; id: string; hub: string }>;
  const codeToId = new Map(routes.map((r) => [r.code, r.id]));
  const codeToHub = new Map(routes.map((r) => [r.code, r.hub]));

  const rows: Array<any> = [];
  const perSheet: Array<{ sheet: string; status: string; ok: number; hub: string | null }> = [];

  wb.eachSheet((ws) => {
    const key = normHeader(ws.name);
    const routeCode = SHEET_TO_ROUTE_CODE[key];
    if (!routeCode) { perSheet.push({ sheet: ws.name, status: "unmapped", ok: 0, hub: null }); return; }
    if (routeCode === "__SKIP__") { perSheet.push({ sheet: ws.name, status: "skipped_legacy", ok: 0, hub: null }); return; }
    if (!codeToId.has(routeCode)) { perSheet.push({ sheet: ws.name, status: "no_route", ok: 0, hub: null }); return; }
    const headerRow = ws.getRow(1);
    const headers: Record<string, number> = {};
    headerRow.eachCell((cell, col) => { headers[normHeader(cell.value)] = col; });
    const colDate = headers["date"], colCap = headers["capacity"];
    const colVendor = headers["vendor pickup capacity"], colDriver = headers["driver"];
    const colPallets = headers["pallet count"], colNotes = headers["notes"], colReturned = headers["returned pallets"];
    if (!colDate || !colCap) { perSheet.push({ sheet: ws.name, status: "no_headers", ok: 0, hub: codeToHub.get(routeCode) ?? null }); return; }
    let ok = 0;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rawDate = row.getCell(colDate).value;
      const { iso, seq } = parseDateCell(rawDate);
      if (!iso) continue;
      if (Number(iso.slice(0, 4)) < 2020) continue;
      const cap = toNum(row.getCell(colCap).value);
      if (cap == null) continue;
      const capClamped = Math.max(0, Math.min(1.25, cap));
      const vpk = colVendor ? toNum(row.getCell(colVendor).value) : null;
      const drv = colDriver ? row.getCell(colDriver).value : null;
      const pc = colPallets ? toNum(row.getCell(colPallets).value) : null;
      const rp = colReturned ? toNum(row.getCell(colReturned).value) : null;
      const notes = colNotes ? row.getCell(colNotes).value : null;
      rows.push({
        route_id: codeToId.get(routeCode)!,
        run_date: iso,
        run_seq: Math.max(1, Math.floor(seq)),
        capacity_frac: capClamped,
        vendor_pickup_frac: vpk == null ? null : Math.max(0, Math.min(1.25, vpk)),
        driver: drv ? String(drv) : null,
        pallet_count: pc == null ? null : Math.round(pc),
        returned_pallets: rp == null ? null : Math.round(rp),
        notes: notes ? String(notes) : null,
      });
      ok++;
    }
    perSheet.push({ sheet: ws.name, status: "ok", ok, hub: codeToHub.get(routeCode) ?? null });
  });

  console.log(`Parsed ${rows.length} rows across ${perSheet.filter((s) => s.status === "ok").length} sheets`);

  // Write CSV to /tmp
  const csvPath = join(tmpdir(), "tc-runs.csv");
  const escape = (v: any) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const csv = ["route_id,run_date,run_seq,capacity_frac,vendor_pickup_frac,driver,pallet_count,returned_pallets,notes"];
  for (const r of rows) csv.push([r.route_id, r.run_date, r.run_seq, r.capacity_frac, r.vendor_pickup_frac ?? "", r.driver ?? "", r.pallet_count ?? "", r.returned_pallets ?? "", r.notes ?? ""].map(escape).join(","));
  writeFileSync(csvPath, csv.join("\n"));

  const sqlPath = join(tmpdir(), "tc-runs.sql");
  writeFileSync(sqlPath, `CREATE TEMP TABLE tc_stage (route_id uuid, run_date date, run_seq int, capacity_frac numeric, vendor_pickup_frac numeric, driver text, pallet_count int, returned_pallets int, notes text);
\\copy tc_stage FROM '${csvPath}' WITH (FORMAT csv, HEADER true, NULL '');
INSERT INTO public.truck_capacity_runs (route_id, run_date, run_seq, capacity_frac, vendor_pickup_frac, driver, pallet_count, returned_pallets, notes, source)
SELECT route_id, run_date, run_seq, capacity_frac, vendor_pickup_frac, NULLIF(driver,''), pallet_count, returned_pallets, NULLIF(notes,''), 'import' FROM tc_stage
ON CONFLICT (route_id, run_date, run_seq) DO UPDATE SET capacity_frac = EXCLUDED.capacity_frac, vendor_pickup_frac = EXCLUDED.vendor_pickup_frac, driver = EXCLUDED.driver, pallet_count = EXCLUDED.pallet_count, returned_pallets = EXCLUDED.returned_pallets, notes = EXCLUDED.notes, source = 'import';
`);
  execSync(`psql -v ON_ERROR_STOP=1 -f "${sqlPath}"`, { stdio: "inherit" });

  // Report per hub
  const byHub = new Map<string, number>();
  for (const s of perSheet) if (s.status === "ok" && s.hub) byHub.set(s.hub, (byHub.get(s.hub) ?? 0) + s.ok);
  console.log("\nRows landed per hub:");
  for (const [hub, n] of [...byHub.entries()].sort()) console.log(`  ${hub.padEnd(15)} ${n}`);
  console.log("\nSheet report:");
  for (const s of perSheet) console.log(`  ${s.sheet.padEnd(30)} ${s.status.padEnd(15)} ok=${s.ok}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
