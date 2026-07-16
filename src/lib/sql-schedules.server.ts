// Server-only helpers for scheduled SQL queries.
import { CronExpressionParser } from "cron-parser";
import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob, applyPricerSync } from "./p21.server";
import { interpolateScheduleTokens } from "./sales-annualized-template";

export type ScheduleRow = {
  id: string;
  name: string;
  description: string | null;
  sql: string;
  params: Record<string, any>;
  action: "email" | "upsert_price_list";
  recipients: string[];
  bcc_recipients: string[];
  email_subject: string | null;
  schedule_cron: string;
  timezone: string;
  active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_row_count: number | null;
  last_error: string | null;
};

export function stripLeadingSqlComments(text: string): string {
  // Strips leading `--` line comments and `/* ... */` block comments, plus
  // any leading whitespace/semicolons, so the "starts with SELECT/WITH/DECLARE"
  // check works when admins prefix a query with an explanatory comment block.
  let s = String(text ?? "");
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^;+\s*/, "");
    s = s.replace(/^--[^\n]*\n?/, "");
    s = s.replace(/^\/\*[\s\S]*?\*\//, "");
    if (s === before) break;
  }
  return s;
}

export function validateSelectSql(text: string) {
  // Strip leading comments/whitespace/semicolons so a query prefixed with an
  // explanatory `-- ...` header still passes the SELECT/WITH/DECLARE check.
  // Multiple statements are allowed — the DB user is db_datareader-only,
  // so writes would fail at the server regardless.
  const stripped = stripLeadingSqlComments(text).replace(/;\s*$/, "");
  const head = stripped.slice(0, 6).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with") && !head.startsWith("declar")) {
    throw new Error("Query must begin with SELECT, WITH, or DECLARE.");
  }
}

function isIdentifierChar(ch: string | undefined) {
  return !!ch && /[A-Za-z0-9_@$#]/.test(ch);
}

function findTopLevelToken(text: string, token: string, start = 0, last = false) {
  const needle = token.toLowerCase();
  let depth = 0;
  let found = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === quote && text[i + 1] === quote) {
          i++;
          continue;
        }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === "[") {
      for (i++; i < text.length && text[i] !== "]"; i++);
      continue;
    }
    if (ch === "-" && next === "-") {
      for (i += 2; i < text.length && text[i] !== "\n"; i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      for (i += 2; i < text.length && !(text[i] === "*" && text[i + 1] === "/"); i++);
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      text.slice(i, i + needle.length).toLowerCase() === needle &&
      !isIdentifierChar(text[i - 1]) &&
      !isIdentifierChar(text[i + needle.length])
    ) {
      found = i;
      if (!last) return found;
    }
  }
  return found;
}

function splitTopLevelSelectList(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      for (i++; i < text.length; i++) {
        if (text[i] === quote && text[i + 1] === quote) {
          i++;
          continue;
        }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === "[") {
      for (i++; i < text.length && text[i] !== "]"; i++);
      continue;
    }
    if (ch === "-" && next === "-") {
      for (i += 2; i < text.length && text[i] !== "\n"; i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      for (i += 2; i < text.length && !(text[i] === "*" && text[i + 1] === "/"); i++);
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function cleanIdentifier(text: string) {
  const s = text.trim().replace(/[;\s]+$/g, "");
  const bracket = s.match(/^\[([^\]]+)]$/);
  if (bracket) return bracket[1];
  const quoted = s.match(/^["']([^"']+)["']$/);
  if (quoted) return quoted[1];
  return s.replace(/^.*\./, "");
}

export function extractFinalSelectColumns(sql: string): string[] {
  const selectAt = findTopLevelToken(sql, "select", 0, true);
  if (selectAt < 0) return [];
  const fromAt = findTopLevelToken(sql, "from", selectAt + 6);
  const list = sql.slice(selectAt + 6, fromAt > selectAt ? fromAt : undefined);
  return splitTopLevelSelectList(list)
    .map((expr) => {
      if (expr === "*" || /\.\s*\*$/.test(expr)) return "";
      const asAt = findTopLevelToken(expr, "as", 0, true);
      if (asAt >= 0) return cleanIdentifier(expr.slice(asAt + 2));
      const bracket = expr.match(/\[([^\]]+)]\s*$/);
      if (bracket) return bracket[1];
      const plain = expr.match(/(?:^|\.)([A-Za-z_][\w@$#]*)\s*$/);
      return plain ? plain[1] : "";
    })
    .filter(Boolean);
}

export function resolveOutputColumns(
  sql: string,
  rows: any[],
  agentColumns?: string[],
): string[] | undefined {
  const parsed = extractFinalSelectColumns(sql);
  if (parsed.length) {
    const first = rows[0];
    if (!first || parsed.every((c) => Object.prototype.hasOwnProperty.call(first, c))) {
      return parsed;
    }
  }
  return agentColumns && agentColumns.length ? agentColumns : parsed.length ? parsed : undefined;
}

export function computeNextRun(cron: string, tz: string, from: Date = new Date()): Date {
  const it = CronExpressionParser.parse(cron, { tz, currentDate: from });
  return it.next().toDate();
}

function toCsv(rows: any[], columns?: string[]): string {
  if (!rows.length) return "";
  // Prefer explicit column order from the agent (preserves SELECT order).
  // Falling back to Object.keys is unreliable because jsonb round-tripping
  // does not preserve object-key order.
  const cols = columns && columns.length ? columns : Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ""));
}

// Detect ISO-8601 date/datetime strings coming back from MSSQL via jsonb.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function coerceCell(v: any): { value: any; numFmt?: string } {
  if (v === null || v === undefined || v === "") return { value: null };
  if (v instanceof Date) return { value: v, numFmt: "m/d/yyyy h:mm:ss" };
  if (typeof v === "number") return { value: v };
  if (typeof v === "boolean") return { value: v };
  if (typeof v === "string") {
    if (/^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) return { value: n };
    }
    if (ISO_DATE_RE.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        return { value: d, numFmt: v.length <= 10 ? "m/d/yyyy" : "m/d/yyyy h:mm:ss" };
      }
    }
    return { value: v };
  }
  return { value: String(v) };
}

async function buildXlsx(rows: any[], columns: string[] | undefined, sheetName: string): Promise<Buffer> {
  const cols = columns && columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nelson AI";
  wb.created = new Date();
  const ws = wb.addWorksheet((sheetName || "Sheet1").slice(0, 31));
  ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(Math.max(c.length + 2, 12), 40) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const r of rows) {
    const out: Record<string, any> = {};
    const fmts: Array<[string, string]> = [];
    for (const c of cols) {
      const { value, numFmt } = coerceCell(r[c]);
      out[c] = value;
      if (numFmt) fmts.push([c, numFmt]);
    }
    const added = ws.addRow(out);
    for (const [c, fmt] of fmts) added.getCell(c).numFmt = fmt;
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

async function sendEmailWithAttachment(opts: {
  to: string[];
  bcc?: string[];
  subject: string;
  htmlIntro: string;
  filename: string;
  content: Buffer;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = process.env.NELSON_FROM_EMAIL || "Nelson AI <noreply@nelsonbot.ai>";
  const payload: Record<string, unknown> = {
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.htmlIntro,
    attachments: [
      { filename: opts.filename, content: opts.content.toString("base64") },
    ],
  };
  if (opts.bcc && opts.bcc.length > 0) payload.bcc = opts.bcc;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend send failed [${r.status}]: ${body.slice(0, 300)}`);
  }
  return r.json();
}


export async function executeSchedule(scheduleId: string): Promise<{
  status: "success" | "error";
  rowCount: number;
  error?: string;
}> {
  const { data: row, error } = await supabaseAdmin
    .from("sql_schedules")
    .select("*")
    .eq("id", scheduleId)
    .single();
  if (error || !row) throw new Error("Schedule not found");

  const schedule = {
    ...row,
    params: (row.params as any) ?? {},
    recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
    bcc_recipients: Array.isArray((row as any).bcc_recipients) ? ((row as any).bcc_recipients as string[]) : [],
  } as ScheduleRow;

  const startedAt = new Date();
  let status: "success" | "error" = "success";
  let rowCount = 0;
  let lastError: string | null = null;

  try {
    if (schedule.action === "upsert_price_list") {
      // Re-use the pricer.sync handler (canonical 9-supplier query) regardless
      // of stored SQL. The schedule row simply controls timing.
      const res = await applyPricerSync();
      rowCount = res.imported ?? 0;
    } else {
      const renderedSql = interpolateScheduleTokens(schedule.sql, startedAt);
      validateSelectSql(renderedSql);
      const { result } = await runJob(
        "sql.select",
        { sql: renderedSql, params: schedule.params, slug: `schedule:${schedule.id}` },
        120_000
      );
      const rows = ((result as any)?.rows ?? []) as any[];
      const columns = resolveOutputColumns(renderedSql, rows, ((result as any)?.columns ?? undefined) as string[] | undefined);
      rowCount = rows.length;

      if (schedule.recipients.length === 0) {
        throw new Error("No recipients configured");
      }
      const dateStr = startedAt.toISOString().slice(0, 10).replace(/-/g, "");
      const subject = renderTemplate(
        schedule.email_subject || "{{name}} — {{date}} ({{rows}} rows)",
        { name: schedule.name, date: dateStr, rows: rowCount }
      );
      const html = `<p>Scheduled report <strong>${schedule.name}</strong> ran at ${startedAt.toISOString()} and returned <strong>${rowCount}</strong> row${rowCount === 1 ? "" : "s"}.</p><p>Results are attached as an Excel workbook.</p>`;
      const safeName = schedule.name.replace(/[^a-z0-9-_]+/gi, "_");
      const filename = `${safeName}-${dateStr}.xlsx`;
      const content = await buildXlsx(rows, columns, schedule.name);
      await sendEmailWithAttachment({
        to: schedule.recipients,
        bcc: schedule.bcc_recipients,
        subject,
        htmlIntro: html,
        filename,
        content,
      });
    }
  } catch (e: any) {
    status = "error";
    lastError = e?.message ?? String(e);
  }

  let nextRunAt: string | null = null;
  try {
    nextRunAt = computeNextRun(schedule.schedule_cron, schedule.timezone, new Date()).toISOString();
  } catch {
    nextRunAt = null;
  }

  await supabaseAdmin
    .from("sql_schedules")
    .update({
      last_run_at: startedAt.toISOString(),
      last_status: status,
      last_row_count: rowCount,
      last_error: lastError,
      next_run_at: nextRunAt,
    })
    .eq("id", schedule.id);

  await supabaseAdmin.from("activity_events").insert({
    event_type: status === "success" ? "sql_schedule.ran" : "sql_schedule.failed",
    entity_type: "sql_schedule",
    entity_id: schedule.id,
    message:
      status === "success"
        ? `Schedule "${schedule.name}" ran (${rowCount} rows, action=${schedule.action})`
        : `Schedule "${schedule.name}" failed: ${lastError}`,
    metadata: { rowCount, action: schedule.action },
  });

  return { status, rowCount, error: lastError ?? undefined };
}

export async function executeDueSchedules(): Promise<{
  processed: number;
  results: Array<{ id: string; name: string; status: string; rowCount: number; error?: string }>;
}> {
  const nowIso = new Date().toISOString();
  const { data: due } = await supabaseAdmin
    .from("sql_schedules")
    .select("id, name, schedule_cron, timezone, next_run_at")
    .eq("active", true)
    .lte("next_run_at", nowIso)
    .limit(50);

  const results: Array<{ id: string; name: string; status: string; rowCount: number; error?: string }> = [];
  for (const s of due ?? []) {
    // Atomically claim by advancing next_run_at past now. Concurrent runners
    // racing on the same row serialize in Postgres: the loser's filter
    // (next_run_at <= nowIso) no longer matches, so it gets zero rows back
    // and skips. Prevents double sends when two cron ticks overlap.
    let claimedNext: string;
    try {
      claimedNext = computeNextRun(s.schedule_cron, (s as any).timezone ?? "UTC", new Date()).toISOString();
    } catch {
      claimedNext = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    const { data: claimed } = await supabaseAdmin
      .from("sql_schedules")
      .update({ next_run_at: claimedNext })
      .eq("id", s.id)
      .eq("active", true)
      .lte("next_run_at", nowIso)
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    try {
      const r = await executeSchedule(s.id);
      results.push({ id: s.id, name: s.name, status: r.status, rowCount: r.rowCount, error: r.error });
    } catch (e: any) {
      results.push({ id: s.id, name: s.name, status: "error", rowCount: 0, error: e?.message ?? String(e) });
    }
  }
  return { processed: results.length, results };
}
