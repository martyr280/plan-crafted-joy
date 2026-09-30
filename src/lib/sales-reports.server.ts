import { fetchAllRows } from "./supabase-fetch-all";
// Server-only helpers for the Sales Reports module (replaces the 25 monthly
// per-salesperson "Upshaw" Excel workbooks).
//
// SQL + rules come from buildSalesReportSql() in ./sales-annualized-template
// (the 2026-09-30 invoice-line / order-rep definition). Do not fork it.

import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import { dateStrInTz } from "@/lib/tz";
import {
  buildSalesReportSql,
  REP_DISCOVERY_SQL,
  REP_DISCOVERY_SQL_NO_EMAIL,
  P21_CONTACTS_SQL,
  workbookHeaders,
  SHORT_MONTH_NAMES,
  deriveColumns,
  keepLevel,
  includeRow,
} from "./sales-annualized-template";
import { isKeepLevelExempt, summarizeByRep, type SalesReportRow } from "./sales-reports.shared";

export { summarizeByRep, isAtRisk, isDeclining, isWinBack, isKeepLevelExempt } from "./sales-reports.shared";
import { isAtRisk as isAtRiskShared } from "./sales-reports.shared";
export type { SalesReportRow, RepSummary } from "./sales-reports.shared";

import { matchRep, type P21Contact } from "./rep-contact-match";
export type Rep = { rep_code: string; rep_name: string | null; rep_email: string | null };

export type RepStatus = {
  rep_code: string;
  rep_name: string;
  status: "ok" | "no_activity" | "error";
  rows: number;
  error?: string;
};

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$,%\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function str(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Previous completed month, which is what the workbook's [Month] columns show. */
export function reportPeriod(now: Date = new Date()): { year: number; month: number; monthLabel: string; currentYear: number } {
  const [y, m] = dateStrInTz(now).split("-").map(Number);
  const prevIdx = m === 1 ? 11 : m - 2;
  const year = m === 1 ? y - 1 : y;
  return { year, month: prevIdx + 1, monthLabel: SHORT_MONTH_NAMES[prevIdx], currentYear: y };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isTransientBridgeError(msg: string): boolean {
  return /connection is closed|timed? ?out|timeout/i.test(msg);
}

/** Read-only: every P21 contact (id, names, email, delete flag) for name matching. */
export async function fetchP21Contacts(timeoutMs = 60_000): Promise<P21Contact[]> {
  const { result } = await runJob("sql.select", { sql: P21_CONTACTS_SQL, params: {}, maxRows: 50_000, slug: "p21-contacts" }, timeoutMs);
  return (((result as any)?.rows ?? []) as any[]).map((c) => ({
    id: String(c.id).trim(), first_name: c.first_name ?? null, last_name: c.last_name ?? null, email: c.email || null, delete_flag: c.delete_flag ?? null,
  }));
}

/** Rep discovery: 3 attempts, 10s apart, on transient errors; NULL-email fallback on a bad contacts column. */
export async function discoverSalesReps(timeoutMs = 60_000): Promise<Rep[]> {
  let sql = REP_DISCOVERY_SQL;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { result } = await runJob("sql.select", { sql, params: {}, slug: "rep-discovery" }, timeoutMs);
      const reps = ((result as any)?.rows ?? []) as Rep[];
      const contacts = await fetchP21Contacts(timeoutMs);
      return reps.map((r) => {
        const m = matchRep(r.rep_name, contacts);
        return { ...r, rep_email: m.kind === "match" ? m.contact.email!.trim() : null };
      });
    } catch (e: any) {
      lastErr = e;
      const msg = e?.message ?? String(e);
      if (sql === REP_DISCOVERY_SQL && /invalid column name|invalid object name.*contacts/i.test(msg)) {
        sql = REP_DISCOVERY_SQL_NO_EMAIL;
        attempt--; // column fallback does not consume a retry
        continue;
      }
      if (attempt < 3 && isTransientBridgeError(msg)) {
        await sleep(10_000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function pickKey(row: Record<string, any>, test: (k: string) => boolean): any {
  for (const k of Object.keys(row)) if (test(k.trim())) return row[k];
  return undefined;
}

/**
 * Keep Lvl as the SQL emits it:
 *  - text code (ISG/OP/L5/MML1...): code only
 *  - numeric: target - Year current (not floored); threshold = TargetSales, code = PriceLevel
 *  - null: all null
 */
export function parseKeepLevel(
  keepRaw: unknown,
  priceLevel: string | null,
  targetSales: number | null,
): { keep_lvl_code: string | null; keep_lvl_threshold: number | null; keep_lvl_shortfall: number | null } {
  const k = str(keepRaw);
  if (!k) return { keep_lvl_code: null, keep_lvl_threshold: null, keep_lvl_shortfall: null };
  const asNum = num(k);
  if (asNum === null) return { keep_lvl_code: k.toUpperCase(), keep_lvl_threshold: null, keep_lvl_shortfall: null };
  return { keep_lvl_code: priceLevel, keep_lvl_threshold: targetSales, keep_lvl_shortfall: asNum };
}

/** Parsed row plus how the TS mirror of the rules compares to what SQL emitted. */
export type ParsedReportRow = { row: SalesReportRow; parityMismatch: string | null };

/**
 * Turn one raw P21 row into a sales_report_rows payload. Rep comes from the
 * row's [Rep] column (order rep / invoice rep), falling back to `rep`.
 * Derived columns are recomputed with the pure rules and compared with SQL.
 */
export function parseReportRow(raw: Record<string, any>, rep: Rep, month = 0): SalesReportRow | null {
  return parseReportRowChecked(raw, rep, month)?.row ?? null;
}

export function parseReportRowChecked(raw: Record<string, any>, rep: Rep, month = 0): ParsedReportRow | null {
  const custCode = str(pickKey(raw, (k) => /^cust\s*code$/i.test(k)));
  if (!custCode) return null;
  const col = (re: RegExp) => pickKey(raw, (k) => re.test(k));

  const yearOf = (y: number) => num(col(new RegExp(`^year ${y}$`, "i")));
  const priceLevel = str(col(/^price$/i)) ?? str(col(/^pricelevel$/i));
  const targetSales = num(col(/^targetsales$/i));
  const repCode = str(col(/^rep$/i)) ?? rep.rep_code;
  const repName = str(col(/^repname$/i)) ?? rep.rep_name ?? repCode;

  const row = {
    rep_code: repCode,
    rep_name: repName,
    cust_code: custCode,
    price_level: priceLevel,
    bg: str(col(/^bg$/i)),
    customer_name: str(col(/^customer\s*name$/i)),
    city: str(col(/^city$/i)),
    state: str(col(/^st$/i)),
    total_value: num(col(/^total\s*value$/i)),
    y2022: yearOf(2022),
    y2023: yearOf(2023),
    y2024: yearOf(2024),
    y2025: yearOf(2025),
    y_current: num(col(/^year\s+current$/i)),
    ann_current: num(col(/^ann\s+current$/i)),
    pct: num(col(/^pct$/i)),
    month_sales: num(col(/^month\s+sales$/i)),
    month_profit: num(col(/^month\s+profit$/i)),
    ...parseKeepLevel(col(/^keep\s*lvl$/i), priceLevel, targetSales),
    customer_id: str(col(/^customerid$/i)) ?? custCode,
    ship_to_id: str(col(/^shiptoid$/i)),
    target_sales: targetSales,
    sales_rep_id: repCode,
  } as SalesReportRow;

  let parityMismatch: string | null = null;
  const prior = num(col(/^prioryear$/i));
  if (month >= 1 && prior !== null) {
    const agg = { y2022: row.y2022 ?? 0, y2023: row.y2023 ?? 0, y2024: row.y2024 ?? 0, y2025: row.y2025 ?? 0, ytd: row.y_current ?? 0, priorYear: prior };
    const d = deriveColumns(agg, month);
    const k = keepLevel(str(col(/^buyinggroup$/i)), priceLevel, targetSales, agg.ytd);
    const off = (a: number | null, b: number | null, tol: number) => (a === null || b === null ? a !== b : Math.abs(a - b) > tol);
    const bad: string[] = [];
    if (!includeRow(agg)) bad.push("inclusion");
    if (off(d.total_value, row.total_value, 0.011)) bad.push("total_value");
    if (off(d.ann_current, row.ann_current, 0.011)) bad.push("ann_current");
    if (off(d.pct, row.pct, 0.00011)) bad.push("pct");
    const kc = k?.kind === "code" ? k.code.toUpperCase() : null;
    const kn = k?.kind === "number" ? k.value : null;
    if (kc !== row.keep_lvl_code && kn === null) bad.push("keep_lvl_code");
    if (off(kn, row.keep_lvl_shortfall, 0.011)) bad.push("keep_lvl");
    parityMismatch = bad.length ? `${repCode}/${custCode}: ${bad.join(",")}` : null;
  }
  return { row, parityMismatch };
}

export type ReportQueryResult = { rows: SalesReportRow[]; unattributed: SalesReportRow[]; parityMismatches: string[] };

/** Run the report for ONE period (one rep, or every rep) through the bridge. No writes. */
export async function querySalesReport(year: number, month: number, repCode: string | null = null): Promise<ReportQueryResult> {
  const sql = buildSalesReportSql({ repCode, year, month });
  const { result } = await runJob(
    "sql.select",
    { sql, params: {}, maxRows: 200_000, slug: repCode ? `sales-annualized-${repCode}` : "sales-annualized-all" },
    600_000,
  );
  if ((result as any)?.truncated) throw new Error("Sales report result was truncated by the bridge; refusing a partial run");
  const raws = ((result as any)?.rows ?? []) as Record<string, any>[];
  const fallback: Rep = { rep_code: repCode ?? "", rep_name: null, rep_email: null };
  const rows: SalesReportRow[] = [];
  const unattributed: SalesReportRow[] = [];
  const parityMismatches: string[] = [];
  for (const raw of raws) {
    const p = parseReportRowChecked(raw, fallback, month);
    if (!p) continue;
    if (p.parityMismatch) parityMismatches.push(p.parityMismatch);
    if (!p.row.rep_code) unattributed.push(p.row);
    else rows.push(p.row);
  }
  return { rows, unattributed, parityMismatches };
}

/** Back-compat: one rep's rows. */
export async function querySalesReportForRep(rep: Rep, year: number, month: number): Promise<SalesReportRow[]> {
  return (await querySalesReport(year, month, rep.rep_code)).rows;
}

async function createRun(year: number, month: number, triggeredBy: string | null) {
  const { data: run, error } = await supabaseAdmin
    .from("sales_report_runs")
    .insert({ period_year: year, period_month: month, triggered_by: triggeredBy, status: "running" })
    .select("id")
    .single();
  if (error || !run) throw new Error(error?.message ?? "Failed to create run");
  return run.id as string;
}

async function persistRepRows(runId: string, rows: SalesReportRow[]) {
  const withRun = rows.map((r) => ({ ...r, run_id: runId }));
  for (let i = 0; i < withRun.length; i += 500) {
    const { error } = await supabaseAdmin.from("sales_report_rows").insert(withRun.slice(i, i + 500) as any);
    if (error) throw new Error(error.message);
  }
}

function repOutcome(rep: Rep, repName: string, rows: SalesReportRow[]): RepStatus {
  const active = rows.some((r) => (r.total_value ?? 0) !== 0);
  return { rep_code: rep.rep_code, rep_name: repName, status: active ? "ok" : "no_activity", rows: rows.length };
}

async function finishRun(runId: string, repStatus: RepStatus[]) {
  const failed = repStatus.filter((r) => r.status === "error").length;
  const status = repStatus.length === 0 ? "error" : failed === repStatus.length ? "error" : failed > 0 ? "partial" : "done";
  await supabaseAdmin
    .from("sales_report_runs")
    .update({
      status,
      rep_count: repStatus.filter((r) => r.status !== "error").length,
      rep_status: repStatus as any,
      error: failed > 0 ? `${failed} of ${repStatus.length} reps failed` : null,
    })
    .eq("id", runId);
  return status;
}

/**
 * Execute the report once per rep and persist a new run for the given period
 * (default: previous completed month). Per-rep error isolation.
 */
export async function runSalesReports(
  opts: { triggeredBy?: string | null; now?: Date; year?: number; month?: number } = {},
) {
  const now = opts.now ?? new Date();
  const def = reportPeriod(now);
  const year = opts.year ?? def.year;
  const month = opts.month ?? def.month;
  buildSalesReportSql({ repCode: "x", year, month }); // validate before creating a run
  const runId = await createRun(year, month, opts.triggeredBy ?? null);

  const repStatus: RepStatus[] = [];
  let q: ReportQueryResult;
  try {
    q = await querySalesReport(year, month, null);
  } catch (e: any) {
    await supabaseAdmin
      .from("sales_report_runs")
      .update({ status: "error", error: `Report query failed: ${e?.message ?? String(e)}` })
      .eq("id", runId);
    return { runId, status: "error" as const, reps: 0, rows: 0, repStatus, unattributed: [], parityMismatches: [] };
  }

  const byRep = new Map<string, SalesReportRow[]>();
  for (const r of q.rows) {
    const list = byRep.get(r.rep_code) ?? [];
    list.push(r);
    byRep.set(r.rep_code, list);
  }
  let totalRows = 0;
  for (const [code, rows] of [...byRep.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const repName = (rows.find((r) => r.rep_name)?.rep_name || code).trim();
    const named = rows.map((r) => ({ ...r, rep_name: repName }));
    const rep: Rep = { rep_code: code, rep_name: repName, rep_email: null };
    try {
      await persistRepRows(runId, named);
      totalRows += named.length;
      repStatus.push(repOutcome(rep, repName, named));
    } catch (e: any) {
      repStatus.push({ rep_code: code, rep_name: repName, status: "error", rows: 0, error: e?.message ?? String(e) });
    }
  }

  const status = await finishRun(runId, repStatus);
  return { runId, status, reps: repStatus.length, rows: totalRows, repStatus, unattributed: q.unattributed, parityMismatches: q.parityMismatches };
}

/** Test hook: one rep, one period. persist=false returns rows without writing a run. */
export async function runSalesReportForRep(opts: {
  repCode: string;
  year: number;
  month: number;
  persist: boolean;
  triggeredBy?: string | null;
}) {
  const repCode = opts.repCode.trim();
  const sql = buildSalesReportSql({ repCode, year: opts.year, month: opts.month }); // validates
  void sql;
  const rep: Rep = { rep_code: repCode, rep_name: null, rep_email: null };
  let runId: string | null = null;
  if (opts.persist) runId = await createRun(opts.year, opts.month, opts.triggeredBy ?? null);
  try {
    const raw = await querySalesReportForRep(rep, opts.year, opts.month);
    const repName = raw.find((r) => r.rep_name)?.rep_name ?? repCode;
    const rows = raw.map((r) => ({ ...r, rep_name: repName }));
    let status: RepStatus = repOutcome(rep, repName, rows);
    if (runId) {
      await persistRepRows(runId, rows);
      await finishRun(runId, [status]);
    }
    const sum = (f: (r: SalesReportRow) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
    return {
      runId,
      status: status.status,
      rowCount: rows.length,
      totals: {
        total_value: sum((r) => r.total_value),
        y_current: sum((r) => r.y_current),
        month_sales: sum((r) => r.month_sales),
        month_profit: sum((r) => r.month_profit),
      },
      rows: rows.slice(0, 20),
    };
  } catch (e: any) {
    if (runId) await finishRun(runId, [{ rep_code: repCode, rep_name: repCode, status: "error", rows: 0, error: e?.message ?? String(e) }]);
    throw e;
  }
}

/** Paginated fetch of every row on a run (bypasses the 1000-row Data API cap). */
export async function fetchRunRows(client: any, runId: string, repCode?: string | null): Promise<SalesReportRow[]> {
  // month_sales is heavily tied (most rows are 0), so id is the unique
  // tiebreaker that keeps page boundaries stable across .range() windows.
  const rows = await fetchAllRows<SalesReportRow>((from, to) => {
    let q = client
      .from("sales_report_rows")
      .select("*")
      .eq("run_id", runId)
      .order("month_sales", { ascending: false })
      .order("id", { ascending: true });
    if (repCode) q = q.eq("rep_code", repCode);
    return q.range(from, to);
  });
  assertUniqueIds(rows);
  return rows;
}

/** Refuse to return a paged set that contains duplicate row ids. */
export function assertUniqueIds(rows: { id?: string }[]) {
  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length) {
    throw new Error(`sales_report_rows paging returned ${rows.length} rows but ${ids.size} distinct ids; refusing to use an unstable row set`);
  }
}

/** Rebuild the original workbook layout for one rep. */
export async function buildRepWorkbook(
  client: any,
  runId: string,
  repCode: string,
): Promise<{ filename: string; buffer: Buffer }> {
  const { data: run } = await client
    .from("sales_report_runs")
    .select("period_year, period_month, run_at")
    .eq("id", runId)
    .single();
  const year = run?.period_year ?? new Date().getFullYear();
  const monthIdx = (run?.period_month ?? 1) - 1;
  const monthLabel = SHORT_MONTH_NAMES[Math.max(0, Math.min(11, monthIdx))];
  const rows = await fetchRunRows(client, runId, repCode);
  const repName = rows[0]?.rep_name ?? repCode;
  const buffer = await renderRepWorkbook(rows, repCode, year, monthLabel);
  const safe = (repName || repCode).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { filename: `${safe}-Sales-Annualized-${monthLabel}-${year}.xlsx`, buffer };
}

/** Render one rep's workbook from rows the caller already fetched and checked. */
export async function renderRepWorkbook(
  rows: SalesReportRow[],
  repCode: string,
  year: number,
  monthLabel: string,
): Promise<Buffer> {
  const repName = rows[0]?.rep_name ?? repCode;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nelson AI";
  const ws = wb.addWorksheet(repName.slice(0, 28) || repCode);
  const headers = workbookHeaders(year, monthLabel);
  ws.addRow([`${repName} — Sales Annualized (${monthLabel} ${year})`]);
  ws.getRow(1).font = { name: "Arial", bold: true, size: 12 };
  ws.addRow([]);
  const headerRow = ws.addRow(headers);
  headerRow.font = { name: "Arial", bold: true };
  headerRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    c.border = { bottom: { style: "thin" } };
  });

  const money = '$#,##0;($#,##0);-';
  const pct = "0.0%";
  ws.columns = [
    { width: 12 }, { width: 10 }, { width: 8 }, { width: 34 }, { width: 18 }, { width: 6 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
    { width: 14 }, { width: 14 }, { width: 9 }, { width: 14 }, { width: 14 }, { width: 12 },
  ];

  for (const r of rows) {
    // Keep Lvl cell: the code (ISG/OP...) or the shortfall number, as the view emits it.
    const keep = r.keep_lvl_shortfall !== null && r.keep_lvl_shortfall !== undefined
      ? r.keep_lvl_shortfall
      : isKeepLevelExempt(r.keep_lvl_code) || r.keep_lvl_code
        ? r.keep_lvl_code
        : null;
    const row = ws.addRow([
      r.cust_code, r.price_level, r.bg, r.customer_name, r.city, r.state,
      r.total_value, r.y2022, r.y2023, r.y2024, r.y2025,
      r.y_current, r.ann_current, r.pct,
      r.month_sales, r.month_profit, keep,
    ]);
    row.font = { name: "Arial" };
    for (const i of [7, 8, 9, 10, 11, 12, 13, 15, 16]) row.getCell(i).numFmt = money;
    row.getCell(14).numFmt = pct;
    if ((r.pct ?? 0) < 0) row.getCell(14).font = { name: "Arial", color: { argb: "FFFF0000" } };
    if (typeof keep === "number") {
      row.getCell(17).numFmt = money;
      // Highlight only rows the shared at-risk rule flags (met 2025 target, pacing below now).
      if (isAtRiskShared(r)) row.getCell(17).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
    }
  }

  const first = 4;
  const last = ws.rowCount;
  if (last >= first) {
    const totals = ws.addRow(["TOTAL", "", "", `${rows.length} customers`, "", "", ...[7, 8, 9, 10, 11, 12, 13].map(() => null)]);
    totals.font = { name: "Arial", bold: true };
    for (const i of [7, 8, 9, 10, 11, 12, 13, 15, 16]) {
      const col = ws.getColumn(i).letter;
      totals.getCell(i).value = { formula: `SUM(${col}${first}:${col}${last})` };
      totals.getCell(i).numFmt = money;
    }
    totals.border = { top: { style: "thin" } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
