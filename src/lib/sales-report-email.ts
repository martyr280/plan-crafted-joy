// Client-safe planning + isolation checks for emailing each rep their own report.
// The server re-runs planSends itself; nothing a browser sends decides a recipient.
import { isAtRisk, type SalesReportRow } from "./sales-reports.shared";

export type RepContact = {
  rep_code: string;
  rep_name: string | null;
  email: string | null;
  cc_emails: string[] | null;
  send_enabled: boolean;
  notes?: string | null;
};

export type RunRep = { rep_code: string; rep_name: string | null; rows: number; status: string };

export type PriorSend = { rep_code: string; status: string; test_mode: boolean; created_at: string; to_email: string | null };

export type SkipReason = "no_contact" | "send_off" | "no_email" | "no_rows" | "already_sent";

export const SKIP_LABEL: Record<SkipReason, string> = {
  no_contact: "No contact row",
  send_off: "Send is off",
  no_email: "No email",
  no_rows: "No rows on this run",
  already_sent: "Already sent for this run (tick “Send again”)",
};

export type PlannedSend = {
  rep_code: string;
  rep_name: string;
  to: string;
  cc: string[];
  rows: number;
  attachment: string;
};

export type PlannedSkip = { rep_code: string; rep_name: string; reason: SkipReason };

export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;
export const isValidEmail = (s: string | null | undefined) => !!s && EMAIL_RE.test(s.trim());

export function attachmentName(repCode: string, year: number, month: number): string {
  const code = repCode.replace(/[^A-Za-z0-9-]+/g, "");
  return `NDI_Sales_${code}_${year}-${String(month).padStart(2, "0")}.xlsx`;
}

/** Last real (non-test) successful send for each rep on this run. */
export function lastRealSends(prior: PriorSend[]): Map<string, PriorSend> {
  const out = new Map<string, PriorSend>();
  for (const p of prior) {
    if (p.status !== "sent" || p.test_mode) continue;
    const cur = out.get(p.rep_code);
    if (!cur || cur.created_at < p.created_at) out.set(p.rep_code, p);
  }
  return out;
}

/**
 * One planned email per rep. Recipients come ONLY from the rep's own contact
 * row, or — in test mode — the signed-in user's session email.
 * Test mode skips only reps with no rows, so layout can be checked for any rep;
 * test sends never count as "already sent".
 */
export function planSends(opts: {
  selected: string[];
  reps: RunRep[];
  contacts: RepContact[];
  prior: PriorSend[];
  year: number;
  month: number;
  sendAgain: boolean;
  testMode: boolean;
  sessionEmail: string | null;
}): { send: PlannedSend[]; skipped: PlannedSkip[] } {
  if (opts.testMode && !isValidEmail(opts.sessionEmail)) throw new Error("Test mode needs a signed-in user with an email");
  const repBy = new Map(opts.reps.map((r) => [r.rep_code, r]));
  const contactBy = new Map(opts.contacts.map((c) => [c.rep_code, c]));
  const sent = lastRealSends(opts.prior);
  const send: PlannedSend[] = [];
  const skipped: PlannedSkip[] = [];
  const seen = new Set<string>();
  for (const code of opts.selected) {
    if (seen.has(code)) continue;
    seen.add(code);
    const rep = repBy.get(code);
    const c = contactBy.get(code);
    const name = rep?.rep_name ?? c?.rep_name ?? code;
    const skip = (reason: SkipReason) => skipped.push({ rep_code: code, rep_name: name, reason });
    if (!rep || rep.rows <= 0) { skip("no_rows"); continue; }
    if (!opts.testMode) {
      if (!c) { skip("no_contact"); continue; }
      if (!c.send_enabled) { skip("send_off"); continue; }
      if (!isValidEmail(c.email)) { skip("no_email"); continue; }
      if (sent.has(code) && !opts.sendAgain) { skip("already_sent"); continue; }
    }
    send.push({
      rep_code: code,
      rep_name: name,
      to: opts.testMode ? opts.sessionEmail!.trim() : c!.email!.trim(),
      cc: opts.testMode ? [] : (c!.cc_emails ?? []).map((e) => e.trim()).filter(isValidEmail),
      rows: rep.rows,
      attachment: attachmentName(code, opts.year, opts.month),
    });
  }
  return { send, skipped };
}

/** Isolation gate: every row belongs to the recipient's rep and the count matches the preview. */
export function verifyRepRows(rows: Pick<SalesReportRow, "rep_code">[], repCode: string, expected: number): string | null {
  const foreign = rows.filter((r) => r.rep_code !== repCode);
  if (foreign.length) return `${foreign.length} row(s) belong to another rep (${[...new Set(foreign.map((r) => r.rep_code))].join(", ")})`;
  if (rows.length !== expected) return `Row count ${rows.length} does not match preview ${expected}`;
  return null;
}

const NON_PERSON = /\b(LLC|INC|GROUP|ACCOUNT|ASSOC|ASSOCIATES|HOUSE|TEAM|SALES|MARKETING|OBSOLETE)\b/i;

export function firstName(repName: string | null | undefined): string {
  const n = (repName ?? "").trim();
  if (!n || NON_PERSON.test(n)) return "there";
  const w = n.split(/\s+/)[0]!;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const usd = (v: number) => (v < 0 ? `($${Math.abs(Math.round(v)).toLocaleString("en-US")})` : `$${Math.round(v).toLocaleString("en-US")}`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function repEmailContent(repName: string | null, year: number, month: number, rows: SalesReportRow[], testMode: boolean) {
  const period = `${MONTHS[month - 1]} ${year}`;
  const ytd = rows.reduce((a, r) => a + (r.y_current ?? 0), 0);
  const mo = rows.reduce((a, r) => a + (r.month_sales ?? 0), 0);
  const atRisk = rows.filter(isAtRisk).length;
  const lines = [
    `Hi ${firstName(repName)}, attached is your ${period} sales report from NDI.`,
    `YTD sales: ${usd(ytd)}`,
    `${MONTHS[month - 1]} sales: ${usd(mo)}`,
    `Keep-level at risk: ${atRisk} account${atRisk === 1 ? "" : "s"}`,
  ];
  const subject = `${testMode ? "[TEST] " : ""}Your ${period} sales report from NDI`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2937">
<p>${esc(lines[0]!)}</p><ul>${lines.slice(1).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<p style="color:#64748b;font-size:12px">Sent by Nelson AI for NDI Office Furniture.</p></div>`;
  return { subject, html, text: lines.join("\n"), figures: { ytd, month: mo, atRisk } };
}
