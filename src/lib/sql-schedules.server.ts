// Server-only helpers for scheduled SQL queries.
import { CronExpressionParser } from "cron-parser";
import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob, applyPricerSync } from "./p21.server";

export type ScheduleRow = {
  id: string;
  name: string;
  description: string | null;
  sql: string;
  params: Record<string, any>;
  action: "email" | "upsert_price_list";
  recipients: string[];
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

export function validateSelectSql(text: string) {
  // Strip leading/trailing semicolons (T-SQL `;WITH` idiom is common).
  const trimmed = text.trim().replace(/^;\s*/, "").replace(/;\s*$/, "");
  const head = trimmed.slice(0, 6).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error("Only SELECT or WITH queries are allowed.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed (remove ';').");
  }
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
  subject: string;
  htmlIntro: string;
  filename: string;
  content: Buffer;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = process.env.NELSON_FROM_EMAIL || "Nelson AI <noreply@nelsonbot.ai>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.htmlIntro,
      attachments: [
        { filename: opts.filename, content: opts.content.toString("base64") },
      ],
    }),
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
      validateSelectSql(schedule.sql);
      const { result } = await runJob(
        "sql.select",
        { sql: schedule.sql, params: schedule.params, slug: `schedule:${schedule.id}` },
        120_000
      );
      const rows = ((result as any)?.rows ?? []) as any[];
      const columns = ((result as any)?.columns ?? undefined) as string[] | undefined;
      rowCount = rows.length;

      if (schedule.recipients.length === 0) {
        throw new Error("No recipients configured");
      }
      const dateStr = startedAt.toISOString().slice(0, 10);
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
    .select("id, name")
    .eq("active", true)
    .lte("next_run_at", nowIso)
    .limit(50);

  const results: Array<{ id: string; name: string; status: string; rowCount: number; error?: string }> = [];
  for (const s of due ?? []) {
    try {
      const r = await executeSchedule(s.id);
      results.push({ id: s.id, name: s.name, status: r.status, rowCount: r.rowCount, error: r.error });
    } catch (e: any) {
      results.push({ id: s.id, name: s.name, status: "error", rowCount: 0, error: e?.message ?? String(e) });
    }
  }
  return { processed: results.length, results };
}
