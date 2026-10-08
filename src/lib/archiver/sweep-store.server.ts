/** Supabase implementation of SweepStore (service role; RLS does not apply). */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Knowledge, LearnedStore } from "./classify";
import type { MailboxRow, MessageRow, SweepStore } from "./sweep";

const db = supabaseAdmin as any;

async function fetchAll<T>(table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

async function inChunks<T>(values: string[], f: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += 100) out.push(...(await f(values.slice(i, i + 100))));
  return out;
}

export async function loadArchiverKnowledge(): Promise<Knowledge> {
  const teams = await fetchAll<any>("archiver_teams", "key, display_name, folder_path, sender_domains, keywords, kind, active, sort_order",
    (q) => q.eq("kind", "team").eq("active", true).order("sort_order"));
  const learnedRows = await fetchAll<any>("archiver_learned", "bucket, key, team_key, count, source, first_at, last_at, root, run");
  const rules = await fetchAll<any>("archiver_content_rules", "id, phrase, team_key, scope, match, weight", (q) => q.order("id"));
  const routes = await fetchAll<any>("archiver_internal_routes", "address, team_key");
  const multi = await fetchAll<any>("archiver_multi_routes", "id, kind, value, team_keys, scope, match", (q) => q.order("created_at"));
  const learned: LearnedStore = { senders: {}, domains: {} };
  for (const r of learnedRows) {
    (r.bucket === "sender" ? learned.senders : learned.domains)[r.key] = {
      customer: r.team_key, count: r.count, source: r.source, first: r.first_at, last: r.last_at, root: r.root, run: r.run,
    };
  }
  return {
    mapping: teams.map((t) => ({ customerKey: t.key, displayName: t.display_name, folderPath: t.folder_path,
      senderDomains: t.sender_domains ?? [], keywords: t.keywords ?? [] })),
    learned,
    ctxRules: rules.map((r) => ({ id: r.id, phrase: r.phrase, customer: r.team_key, scope: r.scope, match: r.match, weight: Number(r.weight) })),
    internalRoutes: Object.fromEntries(routes.map((r) => [String(r.address).toLowerCase(), r.team_key])),
    multiRoutes: multi.map((m) => ({ id: m.id, kind: m.kind, value: m.value, teams: m.team_keys ?? [], scope: m.scope, match: m.match })),
  };
}

export const supabaseSweepStore: SweepStore = {
  loadKnowledge: loadArchiverKnowledge,
  async teamByFolder() {
    const teams = await fetchAll<any>("archiver_teams", "key, folder_path");
    return new Map(teams.map((t) => [String(t.folder_path).trim().toLowerCase(), t.key]));
  },
  async updateMailbox(id, patch) {
    const { error } = await db.from("archiver_mailboxes").update(patch).eq("id", id);
    if (error) throw new Error(`mailbox update failed: ${error.message}`);
  },
  async existingGraphIds(ids) {
    if (!ids.length) return new Set();
    const rows = await inChunks<any>(ids, async (c) => {
      const { data, error } = await db.from("archiver_messages").select("graph_id").in("graph_id", c);
      if (error) throw new Error(error.message);
      return data ?? [];
    });
    return new Set(rows.map((r) => r.graph_id));
  },
  async existingLedgerKeys(keys) {
    if (!keys.length) return new Set();
    const rows = await inChunks<any>(keys, async (c) => {
      const { data, error } = await db.from("archiver_messages").select("ledger_key").in("ledger_key", c);
      if (error) throw new Error(error.message);
      return data ?? [];
    });
    return new Set(rows.map((r) => r.ledger_key));
  },
  async ledgerDestinations(keys) {
    if (!keys.length) return new Map();
    const rows = await inChunks<any>(keys, async (c) => {
      const { data, error } = await db.from("archiver_ledger").select("key, destination").in("key", c);
      if (error) throw new Error(error.message);
      return data ?? [];
    });
    return new Map(rows.map((r) => [r.key, r.destination]));
  },
  async insertMessage(row: MessageRow) {
    const { data, error } = await db.from("archiver_messages")
      .upsert(row, { onConflict: "ledger_key", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`message insert failed: ${error.message}`);
    return data && data.length ? { id: data[0].id as string } : null;
  },
  async insertDecision({ message_id, engine_version, mode, decision: d }) {
    const { error } = await db.from("archiver_decisions").insert({
      message_id, engine_version, mode, team_key: d.customerKey, also_team_keys: d.alsoCustomers, confidence: d.confidence,
      route_source: d.matchSource, evidence: d.evidence, ambiguity: d.ambiguity, rule_id: d.ruleId, stem: d.stem,
      destination: d.destinationRelPath,
    });
    if (error) throw new Error(`decision insert failed: ${error.message}`);
  },
};

export async function listEnabledMailboxes(): Promise<MailboxRow[]> {
  const { data, error } = await db.from("archiver_mailboxes")
    .select("id, mailbox, folder_path, folder_id, delta_link, start_at").eq("enabled", true);
  if (error) throw new Error(error.message);
  return (data ?? []) as MailboxRow[];
}
