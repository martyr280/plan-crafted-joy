/**
 * Order Mail sweep core. Reads new mail from a watched folder through Graph
 * delta, classifies each email with the v4.5.2 engine and records the
 * decision. Storage, Graph and the clock are injected (see SweepStore and
 * GraphClient) so this file is testable offline and has no Supabase import.
 *
 * Shadow mode (the default) only records decisions: nothing is filed, nothing
 * in Outlook changes, nothing is learned. Live filing is a separate step
 * (onLiveDecision) that only runs when settings.mode === 'live' AND
 * settings.filing_enabled === true.
 */
import { buildClassifyConfig, classify, isExcluded, type Decision, type Knowledge } from "./classify";
import { ledgerKey } from "./import-desktop";
import { isProcessedInOutlook, toChicagoLocal, type GraphClient, type GraphMessageMeta } from "./graph";

export const ENGINE_VERSION = "web-1.0 (v4.5.2 parity)";

export interface MailboxRow {
  id: string;
  mailbox: string; // UPN, or "me" for the connector's own mailbox
  folder_path: string;
  folder_id: string | null;
  delta_link: string | null;
  start_at: string | null;
}

export interface MessageRow {
  mailbox_id: string;
  graph_id: string;
  internet_message_id: string | null;
  ledger_key: string;
  received_at: string;
  received_local: string;
  sender_address: string;
  sender_name: string;
  subject: string;
  body_text: string;
  attachment_names: string[];
  web_link: string | null;
  status: "classified" | "unrouted" | "ignored" | "skipped" | "excluded" | "queued";
  excluded_reason: string | null;
  team_key: string | null;
  also_team_keys: string[];
  confidence: number | null;
  route_source: string | null;
  evidence: string | null;
  ambiguity: string | null;
  rule_id: string | null;
  stem: string | null;
  mode: "shadow" | "live";
  desktop_team_key: string | null;
}

export interface SweepStore {
  loadKnowledge(): Promise<Knowledge>;
  /** folder_path (lower-case) -> team key, including Ignored/Unrouted */
  teamByFolder(): Promise<Map<string, string>>;
  updateMailbox(id: string, patch: Partial<MailboxRow> & { last_sweep_at?: string; last_error?: string | null }): Promise<void>;
  existingGraphIds(ids: string[]): Promise<Set<string>>;
  existingLedgerKeys(keys: string[]): Promise<Set<string>>;
  ledgerDestinations(keys: string[]): Promise<Map<string, string>>;
  /** Insert; returns null when the ledger_key already exists (another copy of the same email). */
  insertMessage(row: MessageRow): Promise<{ id: string } | null>;
  insertDecision(row: { message_id: string; engine_version: string; mode: "shadow" | "live"; decision: Decision }): Promise<void>;
}

export interface SweepDeps {
  store: SweepStore;
  graph: GraphClient;
  settings: Record<string, unknown>;
  now: Date;
  /** Live filing hook (WP-OM6). Not called in shadow mode. */
  onLiveDecision?: (messageId: string, row: MessageRow, meta: GraphMessageMeta, decision: Decision) => Promise<void>;
}

export interface SweepCounts {
  pages: number;
  seen: number;
  removed: number;
  before_start: number;
  already_known: number;
  duplicate_copy: number;
  excluded: number;
  outlook_processed_skipped: number;
  classified: number;
  by_team: Record<string, number>;
  desktop_compared: number;
  desktop_agree: number;
  delta_complete: boolean;
}

export function mailboxBase(mailbox: string): string {
  const m = String(mailbox ?? "").trim();
  return !m || m.toLowerCase() === "me" ? "/me" : `/users/${encodeURIComponent(m)}`;
}

/** Desktop ledger destination -> team key ("Team Texas & LA & MS (+ copies: ...)", "skipped:internal-reply", ...). */
export function destinationToTeam(dest: string, byFolder: Map<string, string>): string | null {
  const d = String(dest ?? "").trim();
  if (!d) return null;
  if (d.toLowerCase().startsWith("skipped:")) return "SKIPPED";
  const primary = d.split(" (+ copies:")[0].trim().toLowerCase();
  return byFolder.get(primary) ?? null;
}

function statusFor(d: Decision): MessageRow["status"] {
  if (d.customerKey === "UNROUTED") return "unrouted";
  if (d.customerKey === "IGNORED") return "ignored";
  if (d.customerKey === "SKIPPED") return "skipped";
  return "classified";
}

export async function sweepMailbox(mb: MailboxRow, deps: SweepDeps, limits = { maxPages: 6, maxNew: 120 }): Promise<SweepCounts> {
  const { store, graph, settings, now } = deps;
  const base = mailboxBase(mb.mailbox);
  const cfg = buildClassifyConfig(settings);
  const bodyChars = Math.max(500, Number(settings.body_chars ?? 4000) || 4000);
  const live = settings.mode === "live" && settings.filing_enabled === true;
  const mode: "shadow" | "live" = live ? "live" : "shadow";
  const processedCategory = String(settings.processed_category ?? "Archived");
  const startAt = mb.start_at ? new Date(mb.start_at) : null;
  const counts: SweepCounts = {
    pages: 0, seen: 0, removed: 0, before_start: 0, already_known: 0, duplicate_copy: 0, excluded: 0,
    outlook_processed_skipped: 0, classified: 0, by_team: {}, desktop_compared: 0, desktop_agree: 0, delta_complete: false,
  };

  let folderId = mb.folder_id;
  if (!folderId) {
    folderId = await graph.resolveFolderId(base, mb.folder_path);
    await store.updateMailbox(mb.id, { folder_id: folderId });
  }

  const knowledge = await store.loadKnowledge();
  const byFolder = await store.teamByFolder();
  let link = mb.delta_link;
  const since = link ? null : (startAt ?? new Date(now.getTime() - 24 * 3600_000)).toISOString().replace(/\.\d{3}Z$/, "Z");
  let newCount = 0;

  while (counts.pages < limits.maxPages && newCount < limits.maxNew) {
    const page = await graph.deltaPage(base, folderId, link, link ? null : since);
    counts.pages++;
    const metas = page.messages.filter((m) => {
      counts.seen++;
      if (m["@removed"] !== undefined) { counts.removed++; return false; }
      if (startAt && new Date(m.receivedDateTime) < startAt) { counts.before_start++; return false; }
      return true;
    });
    const known = await store.existingGraphIds(metas.map((m) => m.id));
    const fresh = metas.filter((m) => {
      if (known.has(m.id)) { counts.already_known++; return false; }
      return true;
    });
    const keys = fresh.map((m) => ledgerKey(m.internetMessageId ?? "", m.id));
    const knownKeys = await store.existingLedgerKeys(keys);
    const ledger = await store.ledgerDestinations(keys);

    for (let i = 0; i < fresh.length; i++) {
      const m = fresh[i];
      const key = keys[i];
      if (knownKeys.has(key)) { counts.duplicate_copy++; continue; }
      if (live && isProcessedInOutlook(m, processedCategory)) { counts.outlook_processed_skipped++; continue; }
      const sender = m.sender?.emailAddress ?? m.from?.emailAddress ?? {};
      const senderAddress = String(sender.address ?? "").trim();
      const receivedLocal = toChicagoLocal(m.receivedDateTime);
      const row: MessageRow = {
        mailbox_id: mb.id, graph_id: m.id, internet_message_id: m.internetMessageId ?? null, ledger_key: key,
        received_at: m.receivedDateTime, received_local: receivedLocal, sender_address: senderAddress,
        sender_name: String(sender.name ?? ""), subject: String(m.subject ?? ""), body_text: "", attachment_names: [],
        web_link: m.webLink ?? null, status: "excluded", excluded_reason: null, team_key: null, also_team_keys: [],
        confidence: null, route_source: null, evidence: null, ambiguity: null, rule_id: null, stem: null, mode,
        desktop_team_key: ledger.has(key) ? destinationToTeam(ledger.get(key)!, byFolder) : null,
      };
      const excluded = isExcluded(senderAddress, settings);
      if (excluded) {
        row.excluded_reason = excluded;
        if (await store.insertMessage(row)) counts.excluded++; else counts.duplicate_copy++;
        newCount++;
        continue;
      }
      const body = (await graph.getBodyText(base, m.id)).slice(0, bodyChars);
      const attachments = m.hasAttachments ? await graph.getAttachmentNames(base, m.id) : [];
      row.body_text = body;
      row.attachment_names = attachments;
      const d = classify({ id: m.id, messageId: m.internetMessageId, senderAddress, senderName: row.sender_name,
        subject: row.subject, receivedAt: receivedLocal, body, attachmentNames: attachments }, knowledge, cfg);
      Object.assign(row, {
        status: live ? "queued" : statusFor(d), team_key: d.customerKey, also_team_keys: d.alsoCustomers,
        confidence: d.confidence, route_source: d.matchSource || null, evidence: d.evidence || null,
        ambiguity: d.ambiguity || null, rule_id: d.ruleId || null, stem: d.stem,
      });
      if (live && (d.customerKey === "SKIPPED")) row.status = "skipped";
      const ins = await store.insertMessage(row);
      if (!ins) { counts.duplicate_copy++; continue; }
      await store.insertDecision({ message_id: ins.id, engine_version: ENGINE_VERSION, mode, decision: d });
      counts.classified++;
      newCount++;
      counts.by_team[d.customerKey] = (counts.by_team[d.customerKey] ?? 0) + 1;
      if (row.desktop_team_key) {
        counts.desktop_compared++;
        if (row.desktop_team_key === d.customerKey) counts.desktop_agree++;
      }
      if (live && deps.onLiveDecision && d.customerKey !== "SKIPPED") await deps.onLiveDecision(ins.id, row, m, d);
    }

    // Persist progress after every page: a crash resumes here, and unique keys stop double inserts.
    const nextLink = page.nextLink ?? page.deltaLink;
    if (nextLink) {
      link = nextLink;
      await store.updateMailbox(mb.id, { delta_link: link, last_sweep_at: now.toISOString(), last_error: null });
    }
    if (!page.nextLink) { counts.delta_complete = true; break; }
  }
  return counts;
}
