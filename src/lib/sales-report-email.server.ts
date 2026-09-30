// Server-only: per-rep Sales Report emails. One email per rep; recipient only
// from sales_rep_contacts (or the session user in test mode); attachment built
// from that rep's own rows and verified before any send.
import { fetchRunRows, renderRepWorkbook } from "./sales-reports.server";
import { SHORT_MONTH_NAMES } from "./sales-annualized-template";
import type { SalesReportRow } from "./sales-reports.shared";
import {
  planSends, verifyRepRows, repEmailContent, attachmentName, lastRealSends,
  type RepContact, type RunRep, type PriorSend, type PlannedSend, type PlannedSkip,
} from "./sales-report-email";

export type Sender = (m: {
  to: string; cc: string[]; subject: string; html: string; text: string; filename: string; content: Buffer;
}) => Promise<{ id: string | null }>;

export type RowFetcher = (runId: string, repCode: string) => Promise<SalesReportRow[]>;

export async function loadSendContext(client: any, runId: string | null) {
  let q = client.from("sales_report_runs").select("id, run_at, period_year, period_month, status, rep_status");
  q = runId ? q.eq("id", runId) : q.eq("status", "done").order("run_at", { ascending: false }).limit(1);
  const { data: run, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (!run) throw new Error("No completed run found");
  const reps: RunRep[] = (Array.isArray(run.rep_status) ? run.rep_status : []).map((r: any) => ({
    rep_code: String(r.rep_code), rep_name: r.rep_name ?? null, rows: Number(r.rows ?? 0), status: String(r.status ?? ""),
  }));
  const [{ data: contacts, error: ce }, { data: prior, error: pe }] = await Promise.all([
    client.from("sales_rep_contacts").select("rep_code, rep_name, email, cc_emails, send_enabled, notes").limit(5000),
    client.from("sales_report_sends").select("rep_code, status, test_mode, created_at, to_email").eq("run_id", run.id).limit(10000),
  ]);
  if (ce) throw new Error(ce.message);
  if (pe) throw new Error(pe.message);
  return {
    run: { id: run.id as string, run_at: run.run_at, year: run.period_year as number, month: run.period_month as number, status: run.status },
    reps, contacts: (contacts ?? []) as RepContact[], prior: (prior ?? []) as PriorSend[],
  };
}

/** Build + verify one rep's attachment. Throws nothing; returns an error string on mismatch. */
export async function buildVerifiedAttachment(
  fetchRows: RowFetcher, runId: string, repCode: string, year: number, month: number, expected: number,
): Promise<{ ok: true; rows: SalesReportRow[]; filename: string; buffer: Buffer } | { ok: false; error: string; rows: number }> {
  const rows = await fetchRows(runId, repCode);
  const err = verifyRepRows(rows, repCode, expected);
  if (err) return { ok: false, error: err, rows: rows.length };
  const buffer = await renderRepWorkbook(rows, repCode, year, SHORT_MONTH_NAMES[month - 1]!);
  return { ok: true, rows, filename: attachmentName(repCode, year, month), buffer };
}

export type SendResult = { rep_code: string; rep_name: string; status: "sent" | "failed" | "skipped"; detail: string | null; to: string | null };

/**
 * Plans on the server from DB state, then sends one by one. `expectedRows` is
 * the preview's row count per rep; a mismatch fails that rep (no send).
 * Every attempt (sent/failed/skipped) writes a sales_report_sends row.
 */
export async function executeSends(opts: {
  ctx: Awaited<ReturnType<typeof loadSendContext>>;
  selected: string[];
  expectedRows: Record<string, number>;
  sendAgain: boolean;
  testMode: boolean;
  sessionEmail: string | null;
  userId: string;
  fetchRows: RowFetcher;
  sender: Sender;
  log: (row: Record<string, unknown>) => Promise<void>;
}): Promise<SendResult[]> {
  const { ctx } = opts;
  const plan = planSends({
    selected: opts.selected, reps: ctx.reps, contacts: ctx.contacts, prior: ctx.prior,
    year: ctx.run.year, month: ctx.run.month, sendAgain: opts.sendAgain, testMode: opts.testMode, sessionEmail: opts.sessionEmail,
  });
  const out: SendResult[] = [];
  const base = { run_id: ctx.run.id, test_mode: opts.testMode, sent_by: opts.userId };
  for (const s of plan.skipped) {
    await opts.log({ ...base, rep_code: s.rep_code, status: "skipped", skip_reason: s.reason });
    out.push({ rep_code: s.rep_code, rep_name: s.rep_name, status: "skipped", detail: s.reason, to: null });
  }
  for (const p of plan.send) {
    const res = await sendOne(p, opts);
    out.push(res);
  }
  return out;
}

async function sendOne(p: PlannedSend, opts: Parameters<typeof executeSends>[0]): Promise<SendResult> {
  const { ctx } = opts;
  const base = { run_id: ctx.run.id, test_mode: opts.testMode, sent_by: opts.userId, rep_code: p.rep_code, to_email: p.to, cc_emails: p.cc, attachment_name: p.attachment };
  const fail = async (msg: string, rows: number | null) => {
    await opts.log({ ...base, status: "failed", skip_reason: msg.slice(0, 500), row_count: rows });
    return { rep_code: p.rep_code, rep_name: p.rep_name, status: "failed" as const, detail: msg, to: p.to };
  };
  try {
    const expected = opts.expectedRows[p.rep_code];
    if (expected === undefined) return await fail("No preview row count supplied for this rep", null);
    if (expected !== p.rows) return await fail(`Preview row count ${expected} differs from run's ${p.rows}`, null);
    const att = await buildVerifiedAttachment(opts.fetchRows, ctx.run.id, p.rep_code, ctx.run.year, ctx.run.month, expected);
    if (!att.ok) return await fail(att.error, att.rows);
    const c = repEmailContent(p.rep_name, ctx.run.year, ctx.run.month, att.rows, opts.testMode);
    const r = await opts.sender({ to: p.to, cc: p.cc, subject: c.subject, html: c.html, text: c.text, filename: att.filename, content: att.buffer });
    await opts.log({ ...base, status: "sent", row_count: att.rows.length, provider_message_id: r.id });
    return { rep_code: p.rep_code, rep_name: p.rep_name, status: "sent", detail: r.id, to: p.to };
  } catch (e: any) {
    return await fail(e?.message ?? String(e), null);
  }
}

export function previewFromContext(ctx: Awaited<ReturnType<typeof loadSendContext>>, o: { selected: string[]; sendAgain: boolean; testMode: boolean; sessionEmail: string | null }) {
  const plan = planSends({ ...o, reps: ctx.reps, contacts: ctx.contacts, prior: ctx.prior, year: ctx.run.year, month: ctx.run.month });
  return { run: ctx.run, ...plan } as { run: typeof ctx.run; send: PlannedSend[]; skipped: PlannedSkip[] };
}

export function repListFromContext(ctx: Awaited<ReturnType<typeof loadSendContext>>) {
  const sent = lastRealSends(ctx.prior);
  const cBy = new Map(ctx.contacts.map((c) => [c.rep_code, c]));
  return ctx.reps.map((r) => {
    const c = cBy.get(r.rep_code);
    return { ...r, email: c?.email ?? null, send_enabled: c?.send_enabled ?? false, last_sent_at: sent.get(r.rep_code)?.created_at ?? null, last_sent_to: sent.get(r.rep_code)?.to_email ?? null };
  });
}

export const dbRowFetcher = (client: any): RowFetcher => (runId, repCode) => fetchRunRows(client, runId, repCode);
