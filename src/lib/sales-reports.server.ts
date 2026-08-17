// Server-only helpers for the Sales Reports module (replaces the 25 monthly
// per-salesperson "Upshaw" Excel workbooks).
//
// The SQL definition is SHARED with the seeded email schedules:
// SALES_ANNUALIZED_SQL from ./sales-annualized-template is the single source of
// truth. Do not fork it.

import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import { dateStrInTz } from "@/lib/tz";
import {
  SALES_ANNUALIZED_SQL,
  REP_DISCOVERY_SQL,
  KEEP_LEVEL_THRESHOLDS,
  interpolateScheduleTokens,
  workbookHeaders,
  SHORT_MONTH_NAMES,
} from "./sales-annualized-template";
import { isKeepLevelExempt, summarizeByRep, type SalesReportRow } from "./sales-reports.shared";

export { summarizeByRep, isAtRisk, isDeclining, isWinBack, isKeepLevelExempt } from "./sales-reports.shared";
export type { SalesReportRow, RepSummary } from "./sales-reports.shared";

export type Rep = { rep_code: string; rep_name: string | null; rep_email: string | null };

export type RepStatus = { rep_code: string; rep_name: string; status: "ok" | "error"; rows: number; error?: string };

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

export async function discoverSalesReps(timeoutMs = 60_000): Promise<Rep[]> {
  const { result } = await runJob("sql.select", { sql: REP_DISCOVERY_SQL, params: {}, slug: "rep-discovery" }, timeoutMs);
  return ((result as any)?.rows ?? []) as Rep[];
}

function pickKey(row: Record<string, any>, test: (k: string) => boolean): any {
  for (const k of Object.keys(row)) if (test(k.trim())) return row[k];
  return undefined;
}

/** Turn one raw P21 row into a sales_report_rows payload. */
export function parseReportRow(raw: Record<string, any>, rep: Rep): SalesReportRow | null {
  const custCode = str(pickKey(raw, (k) => /^cust\s*code$/i.test(k)));
  if (!custCode) return null;

  const yearOf = (y: number) => num(pickKey(raw, (k) => k.toLowerCase() === `year ${y}`));
  const priceLevel = str(pickKey(raw, (k) => /^price$/i.test(k)));
  const yCurrent = num(pickKey(raw, (k) => /^year\s+\d{4}$/i.test(k) && !/2022|2023|2024|2025/.test(k)));
  const annCurrent = num(pickKey(raw, (k) => /^ann\s+\d{4}$/i.test(k)));
  const keepRaw = str(pickKey(raw, (k) => /^keep\s*lvl$/i.test(k)));

  let keepCode: string | null = null;
  let keepThreshold: number | null = null;
  let keepShortfall: number | null = null;
  if (keepRaw) {
    const asNum = num(keepRaw);
    if (asNum !== null) {
      keepThreshold = asNum;
      keepCode = priceLevel;
    } else {
      keepCode = keepRaw.toUpperCase();
    }
  }
  if (keepThreshold === null && keepCode && KEEP_LEVEL_THRESHOLDS[keepCode] !== undefined) {
    keepThreshold = KEEP_LEVEL_THRESHOLDS[keepCode];
  }
  if (keepThreshold !== null) {
    keepShortfall = Math.max(0, keepThreshold - (annCurrent ?? 0));
  }

  return {
    rep_code: rep.rep_code,
    rep_name: rep.rep_name ?? rep.rep_code,
    cust_code: custCode,
    price_level: priceLevel,
    bg: str(pickKey(raw, (k) => /^bg$/i.test(k))),
    customer_name: str(pickKey(raw, (k) => /^customer\s*name$/i.test(k))),
    city: str(pickKey(raw, (k) => /^city$/i.test(k))),
    state: str(pickKey(raw, (k) => /^st$/i.test(k))),
    total_value: num(pickKey(raw, (k) => /^total\s*value$/i.test(k))),
    y2022: yearOf(2022),
    y2023: yearOf(2023),
    y2024: yearOf(2024),
    y2025: yearOf(2025),
    y_current: yCurrent,
    ann_current: annCurrent,
    pct: num(pickKey(raw, (k) => /^pct$/i.test(k))),
    month_sales: num(pickKey(raw, (k) => /sales$/i.test(k) && !/^total/i.test(k))),
    month_profit: num(pickKey(raw, (k) => /profit$/i.test(k))),
    keep_lvl_code: keepCode,
    keep_lvl_threshold: keepThreshold,
    keep_lvl_shortfall: keepShortfall,
  };
}

/**
 * Execute the shared annualized SQL once per rep and persist a new run.
 * Per-rep error isolation: a failing rep is recorded in rep_status and the run
 * continues.
 */
export async function runSalesReports(opts: { triggeredBy?: string | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const period = reportPeriod(now);

  const { data: run, error: runErr } = await supabaseAdmin
    .from("sales_report_runs")
    .insert({
      period_year: period.year,
      period_month: period.month,
      triggered_by: opts.triggeredBy ?? null,
      status: "running",
    })
    .select("id")
    .single();
  if (runErr || !run) throw new Error(runErr?.message ?? "Failed to create run");

  const repStatus: RepStatus[] = [];
  let reps: Rep[] = [];
  try {
    reps = await discoverSalesReps();
  } catch (e: any) {
    await supabaseAdmin
      .from("sales_report_runs")
      .update({ status: "error", error: `Rep discovery failed: ${e?.message ?? String(e)}` })
      .eq("id", run.id);
    return { runId: run.id, status: "error" as const, reps: 0, rows: 0, repStatus };
  }

  const sqlTemplate = interpolateScheduleTokens(SALES_ANNUALIZED_SQL, now);
  let totalRows = 0;

  for (const rep of reps) {
    if (!rep.rep_code) continue;
    const repName = (rep.rep_name || rep.rep_code).trim();
    try {
      const sql = sqlTemplate.replace(/__REPCODE__/g, rep.rep_code.replace(/'/g, "''"));
      const { result } = await runJob("sql.select", { sql, params: {}, slug: `sales-annualized-${rep.rep_code}` }, 180_000);
      const raws = ((result as any)?.rows ?? []) as Record<string, any>[];
      const parsed = raws
        .map((r) => parseReportRow(r, { ...rep, rep_name: repName }))
        .filter((r): r is SalesReportRow => !!r)
        .map((r) => ({ ...r, run_id: run.id }));

      for (let i = 0; i < parsed.length; i += 500) {
        const chunk = parsed.slice(i, i + 500);
        const { error } = await supabaseAdmin.from("sales_report_rows").insert(chunk);
        if (error) throw new Error(error.message);
      }
      totalRows += parsed.length;
      repStatus.push({ rep_code: rep.rep_code, rep_name: repName, status: "ok", rows: parsed.length });
    } catch (e: any) {
      repStatus.push({
        rep_code: rep.rep_code,
        rep_name: repName,
        status: "error",
        rows: 0,
        error: e?.message ?? String(e),
      });
    }
  }

  const failed = repStatus.filter((r) => r.status === "error").length;
  const status = repStatus.length === 0 ? "error" : failed === repStatus.length ? "error" : failed > 0 ? "partial" : "done";

  await supabaseAdmin
    .from("sales_report_runs")
    .update({
      status,
      rep_count: repStatus.filter((r) => r.status === "ok").length,
      rep_status: repStatus as any,
      error: failed > 0 ? `${failed} of ${repStatus.length} reps failed` : null,
    })
    .eq("id", run.id);

  return { runId: run.id, status, reps: repStatus.length, rows: totalRows, repStatus };
}

/** Paginated fetch of every row on a run (bypasses the 1000-row Data API cap). */
export async function fetchRunRows(client: any, runId: string, repCode?: string | null): Promise<SalesReportRow[]> {
  const out: SalesReportRow[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = client.from("sales_report_rows").select("*").eq("run_id", runId).order("month_sales", { ascending: false });
    if (repCode) q = q.eq("rep_code", repCode);
    const { data, error } = await q.range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as SalesReportRow[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
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
    const keep = isKeepLevelExempt(r.keep_lvl_code)
      ? r.keep_lvl_code
      : r.keep_lvl_shortfall !== null
        ? r.keep_lvl_shortfall
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
      if (keep > 0) row.getCell(17).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
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

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const safe = (repName || repCode).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { filename: `${safe}-Sales-Annualized-${monthLabel}-${year}.xlsx`, buffer };
}
