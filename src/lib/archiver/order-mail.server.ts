/**
 * Order Mail server logic behind order-mail.functions.ts. Every export takes an
 * injected Ports object so tests can run against a fake database with no network.
 *
 * Mode: LIVE only when settings.mode === "live" AND settings.filing_enabled === true.
 * In SHADOW nothing here calls performAction, touches archiver_learned (except the
 * admin-only forget), or creates filings / file.* jobs.
 */
import {
  buildClassifyConfig,
  compileDotNetRegex,
  isFreeMailDomain,
  type LearnedStore,
} from "./classify";
import { learnFromHuman, type HumanAction } from "./filing";
import { buildImportPlan, type DesktopFiles } from "./importer";
import {
  chicagoDayBounds,
  ownDomains,
  previewPhrase,
  validateContentRule,
  validateInternalRoute,
  validateMultiRoute,
} from "./rules";

export const PROBE_JOB_ID = "aec30dfe-6540-4bcb-b7f2-2ef8522b0e38";
export const MAIL_BUCKET = "archiver-mail";
export const OPERATOR_ROLES = ["admin", "ops_orders"] as const;
export const LIVE_MIN_AGENT_VERSION = "1.5.0";

export interface Actor {
  id: string;
  name: string;
}
export interface Ports {
  db: any; // service-role client (RLS does not apply)
  hasRole: (userId: string, role: string) => Promise<boolean>;
  getSettings: () => Promise<Record<string, unknown>>;
  graphConfigured: (settings: Record<string, unknown>) => boolean;
  performAction: (
    id: string,
    act: HumanAction | { action: "restore"; toTeam: string },
    user: Actor,
  ) => Promise<any>;
  runTick: () => Promise<any>;
  applyImportPlan: (
    plan: any,
    actor: { userId: string; userName: string; source: string },
  ) => Promise<any>;
  now?: () => Date;
  randomId?: () => string;
}

type Fail = { ok: false; errors: string[] };
const fail = (...errors: string[]): Fail => ({ ok: false, errors });

// ------------------------------------------------------------------ gates

export async function requireOperator(p: Ports, userId: string) {
  if (!userId) throw new Error("Authentication required");
  for (const r of OPERATOR_ROLES) if (await p.hasRole(userId, r)) return;
  throw new Error("Admin or Orders role required");
}
export async function requireAdmin(p: Ports, userId: string) {
  if (!userId || !(await p.hasRole(userId, "admin"))) throw new Error("Admin role required");
}
export function effectiveMode(s: Record<string, unknown>): "live" | "shadow" {
  return s.mode === "live" && s.filing_enabled === true ? "live" : "shadow";
}

async function audit(p: Ports, a: Actor, action: string, row: Record<string, unknown>) {
  const { error } = await p.db
    .from("archiver_actions")
    .insert({ user_id: a.id, user_name: a.name, action, ...row });
  if (error) throw new Error(`audit write failed: ${error.message}`);
}

async function teamKeys(p: Ports): Promise<Set<string>> {
  const { data, error } = await p.db
    .from("archiver_teams")
    .select("key")
    .eq("kind", "team")
    .limit(10000);
  if (error) throw new Error(`teams read failed: ${error.message}`);
  return new Set((data ?? []).map((t: any) => String(t.key)));
}

async function fetchAll(
  p: Ports,
  table: string,
  cols: string,
  f: (q: any) => any = (q) => q,
): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await f(p.db.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

async function count(p: Ports, table: string, f: (q: any) => any = (q) => q): Promise<number> {
  const { count: n, error } = await f(p.db.from(table).select("*", { count: "exact", head: true }));
  if (error) throw new Error(`${table} count failed: ${error.message}`);
  return n ?? 0;
}

const tally = (rows: any[], k: string) =>
  rows.reduce(
    (m: Record<string, number>, r) => ((m[r[k] ?? "null"] = (m[r[k] ?? "null"] ?? 0) + 1), m),
    {},
  );

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

// --------------------------------------------------------------- 1 overview

export async function getOverview(p: Ports) {
  const s = await p.getSettings();
  const now = p.now?.() ?? new Date();
  const { start, end } = chicagoDayBounds(now);
  const { data: mailboxes } = await p.db
    .from("archiver_mailboxes")
    .select("id, mailbox, enabled, last_sweep_at, last_error, start_at")
    .order("created_at");
  const today = await fetchAll(p, "archiver_messages", "status, team_key", (q) =>
    q.gte("received_at", start).lt("received_at", end),
  );
  const unrouted = await count(p, "archiver_messages", (q) => q.eq("team_key", "UNROUTED"));
  const needsReply = await count(p, "archiver_notes", (q) =>
    q.eq("needs_reply", true).eq("done", false),
  );
  const { data: runs } = await p.db
    .from("archiver_runs")
    .select("id, trigger, mode, status, started_at, ended_at, counts, error")
    .order("started_at", { ascending: false })
    .limit(10);
  const openFilings = await fetchAll(p, "archiver_filings", "status", (q) =>
    q.not("status", "in", "(done,superseded)"),
  );
  const { data: lastClaim } = await p.db
    .from("p21_bridge_jobs")
    .select("claimed_at")
    .not("claimed_at", "is", null)
    .order("claimed_at", { ascending: false })
    .limit(1);
  const { data: lastDone } = await p.db
    .from("p21_bridge_jobs")
    .select("completed_at")
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1);
  const { data: agents } = await p.db
    .from("p21_bridge_agents")
    .select("name, version, last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(5);
  const { data: probe } = await p.db
    .from("p21_bridge_jobs")
    .select("id, status, created_at, claimed_at, completed_at")
    .eq("id", PROBE_JOB_ID)
    .maybeSingle();
  return {
    settings: {
      mode: s.mode ?? "shadow",
      filing_enabled: s.filing_enabled === true,
      paused: s.paused === true,
      graph_auth: s.graph_auth === "app" ? "app" : "gateway",
      graph_configured: p.graphConfigured(s),
      effective_mode: effectiveMode(s),
    },
    mailboxes: mailboxes ?? [],
    today: {
      start,
      end,
      total: today.length,
      byStatus: tally(today, "status"),
      byTeam: tally(today, "team_key"),
    },
    unrouted,
    needsReply,
    runs: runs ?? [],
    openFilings: tally(openFilings, "status"),
    bridge: {
      lastClaimedAt: lastClaim?.[0]?.claimed_at ?? null,
      lastCompletedAt: lastDone?.[0]?.completed_at ?? null,
      agents: agents ?? [],
    },
    probeJob: probe ?? null,
  };
}

// --------------------------------------------------------------- 2 listMail

export interface ListMailInput {
  status?: string;
  team?: string;
  q?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}
/** PostgREST .or() text for the mail search box. `,` `(` `)` are the only .or() grammar
 * characters that could break out of the ilike value, so they are replaced with spaces. */
export function mailSearchFilter(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const t = escapeLike(raw.trim()).replace(/[,()]/g, " ");
  return `subject.ilike.%${t}%,sender_address.ilike.%${t}%`;
}

export async function listNeedsReply(p: Ports) {
  const rows = await fetchAll(
    p,
    "archiver_notes",
    "ledger_key, message_id, note, subject, sender, team_key, received, by_name, updated_at",
    (q) => q.eq("needs_reply", true).eq("done", false).order("updated_at", { ascending: false }),
  );
  return rows;
}

export async function listMail(p: Ports, i: ListMailInput) {
  const size = Math.min(Math.max(1, i.pageSize), 100);
  const page = Math.max(0, i.page);
  let q = p.db
    .from("archiver_messages")
    .select(
      "id, received_at, sender_address, sender_name, subject, status, team_key, also_team_keys, confidence, route_source, desktop_team_key, human_team_key, mode",
      { count: "exact" },
    );
  if (i.status) q = q.eq("status", i.status);
  if (i.team) q = q.eq("team_key", i.team);
  if (i.from) q = q.gte("received_at", i.from);
  if (i.to) q = q.lt("received_at", i.to);
  const filter = mailSearchFilter(i.q);
  if (filter) q = q.or(filter);
  const {
    data,
    error,
    count: total,
  } = await q.order("received_at", { ascending: false }).range(page * size, page * size + size - 1);
  if (error) throw new Error(`mail read failed: ${error.message}`);
  const { data: teams } = await p.db
    .from("archiver_teams")
    .select("key, display_name")
    .limit(10000);
  const names = Object.fromEntries((teams ?? []).map((t: any) => [t.key, t.display_name]));
  return {
    page,
    pageSize: size,
    total: total ?? 0,
    rows: (data ?? []).map((r: any) => ({
      ...r,
      team_name: r.team_key ? (names[r.team_key] ?? r.team_key) : null,
    })),
  };
}

// ---------------------------------------------------------------- 3 getMail

export const BODY_LIMIT = 20_000;
export async function getMail(p: Ports, id: string) {
  const { data: msg, error } = await p.db
    .from("archiver_messages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`mail read failed: ${error.message}`);
  if (!msg) throw new Error("email not found");
  const body = String(msg.body_text ?? "");
  const [dec, fil, act, notes] = await Promise.all([
    p.db
      .from("archiver_decisions")
      .select("*")
      .eq("message_id", id)
      .order("decided_at", { ascending: false })
      .limit(50),
    p.db.from("archiver_filings").select("*").eq("message_id", id).order("created_at").limit(200),
    p.db
      .from("archiver_actions")
      .select("*")
      .eq("message_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    p.db.from("archiver_notes").select("*").eq("ledger_key", msg.ledger_key).limit(10),
  ]);
  let emlUrl: string | null = null;
  if (msg.storage_path) {
    const { data } = await p.db.storage.from(MAIL_BUCKET).createSignedUrl(msg.storage_path, 600);
    emlUrl = data?.signedUrl ?? null;
  }
  return {
    message: {
      ...msg,
      body_text: body.slice(0, BODY_LIMIT),
      body_truncated: body.length > BODY_LIMIT,
    },
    decisions: dec.data ?? [],
    filings: fil.data ?? [],
    actions: act.data ?? [],
    notes: notes.data ?? [],
    emlUrl,
  };
}

// -------------------------------------------------------------- 4 listRules

export async function listRules(p: Ports) {
  const contentRules = await fetchAll(
    p,
    "archiver_content_rules",
    "id, phrase, team_key, scope, match, weight, note, hits, last_hit_at, source, enabled, created_at, created_by_name",
    (q) => q.order("id"),
  );
  const internalRoutes = await fetchAll(
    p,
    "archiver_internal_routes",
    "address, team_key, note, source, enabled, created_at, created_by_name",
    (q) => q.order("address"),
  );
  const multiRoutes = await fetchAll(
    p,
    "archiver_multi_routes",
    "id, kind, value, team_keys, scope, match, note, hits, source, enabled, created_at",
    (q) => q.order("created_at"),
  );
  return { contentRules, internalRoutes, multiRoutes };
}

// ---------------------------------------------------------- 5 searchLearned

export async function searchLearned(
  p: Ports,
  i: { q: string; bucket?: "sender" | "domain"; limit: number },
) {
  let q = p.db
    .from("archiver_learned")
    .select("bucket, key, team_key, count, source, first_at, last_at, updated_at");
  if (i.bucket) q = q.eq("bucket", i.bucket);
  if (i.q.trim()) q = q.ilike("key", `%${escapeLike(i.q.trim().toLowerCase())}%`);
  const { data, error } = await q.order("key").limit(Math.min(Math.max(1, i.limit), 200));
  if (error) throw new Error(`learned read failed: ${error.message}`);
  return data ?? [];
}

// ----------------------------------------------------------- 6 shadowReport

export function summarizeShadow(rows: any[]) {
  const compared = rows.filter((r) => r.desktop_team_key != null);
  const disagreed = compared.filter((r) => r.team_key !== r.desktop_team_key);
  const human = rows.filter((r) => r.human_team_key != null);
  return {
    compared: compared.length,
    agreed: compared.length - disagreed.length,
    disagreed: disagreed.length,
    disagreements: disagreed.slice(0, 50).map((r) => ({
      id: r.id,
      subject: r.subject,
      sender: r.sender_address,
      web_team: r.team_key,
      desktop_team: r.desktop_team_key,
      route_source: r.route_source,
      confidence: r.confidence,
    })),
    humanCorrected: {
      total: human.length,
      webRight: human.filter((r) => r.team_key === r.human_team_key).length,
      desktopRight: human.filter(
        (r) => r.desktop_team_key != null && r.desktop_team_key === r.human_team_key,
      ).length,
    },
  };
}
export async function shadowReport(p: Ports, i: { from?: string; to?: string }) {
  const range = (q: any) => {
    if (i.from) q = q.gte("received_at", i.from);
    if (i.to) q = q.lt("received_at", i.to);
    return q;
  };
  const rows = await fetchAll(
    p,
    "archiver_messages",
    "id, subject, sender_address, team_key, desktop_team_key, human_team_key, route_source, confidence, received_at",
    (q) =>
      range(q)
        .or("desktop_team_key.not.is.null,human_team_key.not.is.null")
        .order("received_at", { ascending: false }),
  );
  const noDesktop = await count(p, "archiver_messages", (q) =>
    range(q).is("desktop_team_key", null),
  );
  return { ...summarizeShadow(rows), noDesktopYet: noDesktop };
}

// ------------------------------------------------------------ 8 mailAction

export interface MailActionInput {
  id: string;
  action: "wrong_team" | "archive" | "restore" | "also_file";
  toTeam?: string;
  teams?: string[];
}
export function humanTeamFor(i: MailActionInput): string | undefined {
  if (i.action === "wrong_team" || i.action === "restore") return i.toTeam;
  if (i.action === "archive") return "IGNORED";
  return undefined; // also_file: unchanged
}
export async function mailAction(
  p: Ports,
  a: Actor,
  i: MailActionInput,
): Promise<{ mode: string; recorded: true } | Fail> {
  const keys = await teamKeys(p);
  if ((i.action === "wrong_team" || i.action === "restore") && (!i.toTeam || !keys.has(i.toTeam)))
    return fail(`Unknown team '${i.toTeam ?? ""}'.`);
  if (i.action === "also_file") {
    const t = i.teams ?? [];
    if (!t.length) return fail("Pick at least one team.");
    const bad = t.filter((k) => !keys.has(k));
    if (bad.length) return fail(...bad.map((k) => `Unknown team '${k}'.`));
  }
  const { data: msg } = await p.db
    .from("archiver_messages")
    .select("id, team_key")
    .eq("id", i.id)
    .maybeSingle();
  if (!msg) return fail("Email not found.");
  const s = await p.getSettings();
  const mode = effectiveMode(s);
  if (mode === "live") {
    const act =
      i.action === "wrong_team"
        ? { action: "wrong_team" as const, toTeam: i.toTeam! }
        : i.action === "restore"
          ? { action: "restore" as const, toTeam: i.toTeam! }
          : i.action === "archive"
            ? { action: "archive" as const }
            : { action: "also_file" as const, teams: i.teams! };
    await p.performAction(i.id, act, a); // writes its own archiver_actions row
  } else {
    await audit(p, a, i.action, {
      message_id: i.id,
      from_team: msg.team_key,
      to_team: humanTeamFor(i) ?? null,
      team_keys: i.action === "also_file" ? i.teams : [],
      detail: { shadow: true, requested: i },
    });
  }
  const human = humanTeamFor(i);
  if (human) {
    const { error } = await p.db
      .from("archiver_messages")
      .update({ human_team_key: human })
      .eq("id", i.id);
    if (error) throw new Error(`human_team_key write failed: ${error.message}`);
  }
  return { mode, recorded: true };
}

// --------------------------------------------------------------- 9 setNote

export async function setNote(
  p: Ports,
  a: Actor,
  i: { id: string; text: string; needs_reply?: boolean },
) {
  if (i.text.length > 2000) return fail("Note is too long (max 2000 characters).");
  const { data: m } = await p.db
    .from("archiver_messages")
    .select("id, ledger_key, subject, sender_address, team_key, received_local")
    .eq("id", i.id)
    .maybeSingle();
  if (!m) return fail("Email not found.");
  const row: Record<string, unknown> = {
    ledger_key: m.ledger_key,
    message_id: m.id,
    note: i.text,
    subject: m.subject ?? "",
    sender: m.sender_address ?? "",
    team_key: m.team_key ?? "",
    received: m.received_local ?? "",
    by_name: a.name,
    updated_at: (p.now?.() ?? new Date()).toISOString(),
  };
  if (typeof i.needs_reply === "boolean") row.needs_reply = i.needs_reply; // omitted -> existing value preserved
  const { error } = await p.db.from("archiver_notes").upsert(row, { onConflict: "ledger_key" });
  if (error) throw new Error(`note write failed: ${error.message}`);
  await audit(p, a, "note", {
    message_id: m.id,
    detail: { ledger_key: m.ledger_key, length: i.text.length, needs_reply: i.needs_reply ?? null },
  });
  return { ok: true as const };
}

// ----------------------------------------------------------- 10 rules CRUD

const rand = (p: Ports) => p.randomId?.() ?? Math.random().toString(36).slice(2, 12);
export const webRuleId = (p: Ports) => `web-${rand(p)}`;

/** Shadow: admin only. Live: admin or ops_orders (already checked by caller). */
async function requireRuleEditor(p: Ports, a: Actor) {
  if (effectiveMode(await p.getSettings()) === "shadow") await requireAdmin(p, a.id);
}

async function contentDuplicate(p: Ports, phrase: string, scope: string, exceptId?: string) {
  const { data, error } = await p.db
    .from("archiver_content_rules")
    .select("id, phrase")
    .eq("enabled", true)
    .eq("scope", scope)
    .limit(10000);
  if (error) throw new Error(`rules read failed: ${error.message}`);
  return (data ?? []).some(
    (r: any) => r.id !== exceptId && String(r.phrase).toLowerCase() === phrase.toLowerCase(),
  );
}

export async function createContentRule(
  p: Ports,
  a: Actor,
  raw: {
    phrase?: string;
    team?: string;
    scope?: string;
    match?: string;
    weight?: number;
    note?: string;
  },
) {
  await requireRuleEditor(p, a);
  const v = validateContentRule(raw, await teamKeys(p));
  if (!v.ok) return v;
  if (await contentDuplicate(p, v.value.phrase, v.value.scope))
    return fail("That phrase already exists for this scope.");
  const id = webRuleId(p);
  const { error } = await p.db.from("archiver_content_rules").insert({
    id,
    ...v.value,
    source: "web",
    enabled: true,
    created_by: a.id,
    created_by_name: a.name,
  });
  if (error) throw new Error(`rule insert failed: ${error.message}`);
  await audit(p, a, "rule_add", {
    to_team: v.value.team_key,
    detail: { table: "content", id, ...v.value },
  });
  return { ok: true as const, id };
}

export async function updateContentRule(
  p: Ports,
  a: Actor,
  raw: {
    id: string;
    phrase?: string;
    team?: string;
    scope?: string;
    match?: string;
    weight?: number;
    note?: string;
  },
) {
  await requireRuleEditor(p, a);
  const { data: cur } = await p.db
    .from("archiver_content_rules")
    .select("*")
    .eq("id", raw.id)
    .maybeSingle();
  if (!cur) return fail("Rule not found.");
  const v = validateContentRule(
    {
      phrase: raw.phrase ?? cur.phrase,
      team: raw.team ?? cur.team_key,
      scope: raw.scope ?? cur.scope,
      match: raw.match ?? cur.match,
      weight: raw.weight ?? Number(cur.weight),
      note: raw.note ?? cur.note,
    },
    await teamKeys(p),
  );
  if (!v.ok) return v;
  if (await contentDuplicate(p, v.value.phrase, v.value.scope, raw.id))
    return fail("That phrase already exists for this scope.");
  // source='web' so a later desktop import (withoutProtected) does not overwrite the edit.
  const { error } = await p.db
    .from("archiver_content_rules")
    .update({ ...v.value, source: "web" })
    .eq("id", raw.id);
  if (error) throw new Error(`rule update failed: ${error.message}`);
  await audit(p, a, "rule_add", {
    to_team: v.value.team_key,
    detail: { table: "content", id: raw.id, update: true, before: cur, after: v.value },
  });
  return { ok: true as const, id: raw.id };
}

async function disableRow(
  p: Ports,
  a: Actor,
  table: string,
  col: string,
  val: string,
  label: string,
) {
  await requireRuleEditor(p, a);
  const { data, error } = await p.db
    .from(table)
    .update({ enabled: false })
    .eq(col, val)
    .select(col);
  if (error) throw new Error(`${table} update failed: ${error.message}`);
  if (!data?.length) return fail(`${label} not found.`);
  await audit(p, a, "rule_remove", { detail: { table, [col]: val, enabled: false } });
  return { ok: true as const };
}
export const disableContentRule = (p: Ports, a: Actor, id: string) =>
  disableRow(p, a, "archiver_content_rules", "id", id, "Rule");
export const disableInternalRoute = (p: Ports, a: Actor, address: string) =>
  disableRow(p, a, "archiver_internal_routes", "address", address.trim().toLowerCase(), "Route");
export const disableMultiRoute = (p: Ports, a: Actor, id: string) =>
  disableRow(p, a, "archiver_multi_routes", "id", id, "Rule");

export async function createInternalRoute(
  p: Ports,
  a: Actor,
  raw: { address?: string; team?: string; note?: string },
) {
  await requireRuleEditor(p, a);
  const v = validateInternalRoute(raw, await teamKeys(p), await p.getSettings());
  if (!v.ok) return v;
  const { data: cur } = await p.db
    .from("archiver_internal_routes")
    .select("address, enabled")
    .eq("address", v.value.address)
    .maybeSingle();
  if (cur?.enabled) return fail("That address already has a route.");
  const { error } = await p.db
    .from("archiver_internal_routes")
    .upsert(
      { ...v.value, source: "web", enabled: true, created_by: a.id, created_by_name: a.name },
      { onConflict: "address" },
    );
  if (error) throw new Error(`route write failed: ${error.message}`);
  await audit(p, a, "rule_add", {
    to_team: v.value.team_key,
    detail: { table: "internal", ...v.value, reenabled: !!cur },
  });
  return { ok: true as const, address: v.value.address };
}

export async function createMultiRoute(
  p: Ports,
  a: Actor,
  raw: {
    kind?: string;
    value?: string;
    teams?: string[];
    scope?: string;
    match?: string;
    note?: string;
  },
) {
  await requireRuleEditor(p, a);
  const v = validateMultiRoute(raw, await teamKeys(p), ownDomains(await p.getSettings()));
  if (!v.ok) return v;
  const { data: cur } = await p.db
    .from("archiver_multi_routes")
    .select("id, enabled")
    .eq("kind", v.value.kind)
    .eq("value", v.value.value)
    .maybeSingle();
  if (cur?.enabled) return fail("That rule already exists.");
  const id = cur?.id ?? webRuleId(p);
  const { error } = await p.db
    .from("archiver_multi_routes")
    .upsert(
      { id, ...v.value, source: "web", enabled: true, created_by: a.id, created_by_name: a.name },
      { onConflict: "kind,value" },
    );
  if (error) throw new Error(`multi route write failed: ${error.message}`);
  await audit(p, a, "rule_add", {
    team_keys: v.value.team_keys,
    detail: { table: "multi", id, ...v.value },
  });
  return { ok: true as const, id };
}

// ------------------------------------------------------------ 11 previewRule

export async function previewRule(
  p: Ports,
  rule: { phrase: string; scope?: string; match?: string },
) {
  const { data, error } = await p.db
    .from("archiver_messages")
    .select("subject, body_text, attachment_names, team_key")
    .order("received_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`mail read failed: ${error.message}`);
  const recent = (data ?? []).map((m: any) => ({
    subject: m.subject ?? "",
    body: m.body_text ?? "",
    attachmentNames: m.attachment_names ?? [],
    team_key: m.team_key,
  }));
  return { scanned: recent.length, ...previewPhrase(rule, recent as any) };
}

// ----------------------------------------------------------- 12 teachSender

export async function teachSender(p: Ports, a: Actor, i: { address: string; team: string }) {
  const addr = i.address.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return fail(`'${addr}' is not an email address.`);
  if (!(await teamKeys(p)).has(i.team)) return fail(`Unknown team '${i.team}'.`);
  const s = await p.getSettings();
  const mode = effectiveMode(s);
  if (mode === "shadow" || s.learning_enabled === false) {
    await audit(p, a, "teach", {
      to_team: i.team,
      detail: {
        shadow: mode === "shadow",
        learning_disabled: s.learning_enabled === false,
        address: addr,
      },
    });
    return { mode, recorded: true as const, learned: [] };
  }
  const dom = addr.split("@").pop()!;
  // Two plain .eq() reads: no user text is ever interpolated into a PostgREST filter string.
  const [senderRes, domainRes] = await Promise.all([
    p.db.from("archiver_learned").select("*").eq("bucket", "sender").eq("key", addr).limit(1),
    p.db.from("archiver_learned").select("*").eq("bucket", "domain").eq("key", dom).limit(1),
  ]);
  if (senderRes.error) throw new Error(`learned read failed: ${senderRes.error.message}`);
  if (domainRes.error) throw new Error(`learned read failed: ${domainRes.error.message}`);
  const rows = [...(senderRes.data ?? []), ...(domainRes.data ?? [])];
  const store: LearnedStore = { senders: {}, domains: {} };
  for (const r of rows ?? []) {
    if (r.source === "forgotten") continue; // relearning starts fresh
    (r.bucket === "sender" ? store.senders : store.domains)[r.key] = {
      customer: r.team_key,
      count: r.count,
      source: r.source,
      first: r.first_at,
      last: r.last_at,
      root: r.root,
      run: r.run,
    } as any;
  }
  const cfg = buildClassifyConfig(s);
  const touched = learnFromHuman(store, addr, i.team, "taught", {
    contentOnly: cfg.contentOnly,
    ignoredDomains: cfg.ignoredDomains,
    multiTerritory: cfg.multiTerritory,
    freeMail: isFreeMailDomain,
    now: (p.now?.() ?? new Date()).toISOString().slice(0, 19),
  });
  const upserts = touched.map((t) => {
    const e: any = (t.bucket === "sender" ? store.senders : store.domains)[t.key];
    return {
      bucket: t.bucket,
      key: t.key,
      team_key: e.customer,
      count: e.count ?? 1,
      source: e.source ?? "taught",
      first_at: e.first ?? "",
      last_at: e.last ?? "",
      root: e.root ?? "",
      run: e.run ?? "",
      updated_at: new Date().toISOString(),
    };
  });
  if (upserts.length) {
    const { error } = await p.db
      .from("archiver_learned")
      .upsert(upserts, { onConflict: "bucket,key" });
    if (error) throw new Error(`learned write failed: ${error.message}`);
  }
  await audit(p, a, "teach", { to_team: i.team, detail: { address: addr, learned: touched } });
  return { mode, recorded: true as const, learned: touched };
}

// --------------------------------------------------------- 13 forgetLearned

export async function forgetLearned(
  p: Ports,
  a: Actor,
  i: { bucket: "sender" | "domain"; key: string },
) {
  const key = i.key.trim().toLowerCase();
  const { data, error } = await p.db
    .from("archiver_learned")
    .update({ source: "forgotten", updated_at: new Date().toISOString() })
    .eq("bucket", i.bucket)
    .eq("key", key)
    .select("bucket, key, team_key");
  if (error) throw new Error(`learned update failed: ${error.message}`);
  if (!data?.length) return fail("Learned entry not found.");
  await audit(p, a, "learned_forget", {
    from_team: data[0].team_key,
    detail: { bucket: i.bucket, key },
  });
  return { ok: true as const };
}

// -------------------------------------------------------- 14 updateSettings

const SETTING_KEYS = new Set([
  "mode",
  "filing_enabled",
  "paused",
  "retention_days",
  "learning_enabled",
  "ledger_sync_enabled",
  "processed_marker",
  "processed_category",
  "own_domains",
  "content_only_senders",
  "ignore_subject_patterns",
]);

export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  if (!m) return false;
  const a = [+m[1], +m[2], +m[3]],
    b = min.split(".").map(Number);
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] > b[k];
  return true;
}

export function validateSettingsPatch(
  patch: Record<string, unknown>,
  ctx: { graphConfigured: boolean; agentVersion: string | null },
): string[] {
  const e: string[] = [];
  for (const k of Object.keys(patch)) if (!SETTING_KEYS.has(k)) e.push(`Unknown setting '${k}'.`);
  const bool = (k: string) => {
    if (k in patch && typeof patch[k] !== "boolean") e.push(`${k} must be true or false.`);
  };
  ["filing_enabled", "paused", "learning_enabled", "ledger_sync_enabled"].forEach(bool);
  const str = (k: string) => {
    if (k in patch && typeof patch[k] !== "string") e.push(`${k} must be text.`);
  };
  ["processed_category", "own_domains", "content_only_senders"].forEach(str);
  if ("mode" in patch && patch.mode !== "shadow" && patch.mode !== "live")
    e.push("mode must be shadow or live.");
  if ("retention_days" in patch) {
    const n = patch.retention_days;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 7 || n > 365)
      e.push("retention_days must be a whole number from 7 to 365.");
  }
  if (
    "processed_marker" in patch &&
    !["flag", "category", "both", "none"].includes(patch.processed_marker as string)
  ) {
    e.push("processed_marker must be flag, category, both or none.");
  }
  if ("ignore_subject_patterns" in patch) {
    const v = patch.ignore_subject_patterns;
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : null;
    if (!list) e.push("ignore_subject_patterns must be text or a list.");
    else
      for (const pat of list
        .map(String)
        .map((x) => x.trim())
        .filter(Boolean)) {
        if (!compileDotNetRegex(pat, true)) e.push(`Pattern does not compile: ${pat}`);
      }
  }
  if (patch.mode === "live") {
    if (!ctx.graphConfigured)
      e.push("Live mode needs the Microsoft mail connection configured first.");
    if (!ctx.agentVersion)
      e.push("Live mode refused: the bridge agent version could not be determined.");
    else if (!versionAtLeast(ctx.agentVersion, LIVE_MIN_AGENT_VERSION)) {
      e.push(
        `Live mode needs bridge agent ${LIVE_MIN_AGENT_VERSION} or newer (installed: ${ctx.agentVersion}).`,
      );
    }
  }
  return e;
}

export async function latestAgentVersion(p: Ports): Promise<string | null> {
  const { data } = await p.db
    .from("p21_bridge_agents")
    .select("version, last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(1);
  return data?.[0]?.version ?? null;
}

export async function updateSettings(p: Ports, a: Actor, patch: Record<string, unknown>) {
  const cur = await p.getSettings();
  const errors = validateSettingsPatch(patch, {
    graphConfigured: p.graphConfigured(cur),
    agentVersion: patch.mode === "live" ? await latestAgentVersion(p) : null,
  });
  if (errors.length) return fail(...errors);
  const value = { ...cur, ...patch };
  const { error } = await p.db
    .from("app_settings")
    .upsert(
      { key: "archiver", value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw new Error(`settings write failed: ${error.message}`);
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, cur[k] ?? null]));
  await audit(p, a, "settings", { detail: { before, after: patch } });
  return { ok: true as const };
}

// --------------------------------------------------------- 15 updateMailbox

export async function updateMailbox(
  p: Ports,
  a: Actor,
  i: { id: string; enabled?: boolean; start_at?: string | null; label?: string },
) {
  if (i.label !== undefined)
    return fail("Mailbox label is not stored (archiver_mailboxes has no label column).");
  const patch: Record<string, unknown> = {};
  if (typeof i.enabled === "boolean") patch.enabled = i.enabled;
  if (i.start_at !== undefined) {
    if (i.start_at !== null && Number.isNaN(Date.parse(i.start_at)))
      return fail("start_at must be a date/time.");
    patch.start_at = i.start_at;
  }
  if (!Object.keys(patch).length) return fail("Nothing to change.");
  const { data, error } = await p.db
    .from("archiver_mailboxes")
    .update(patch)
    .eq("id", i.id)
    .select("id, mailbox");
  if (error) throw new Error(`mailbox update failed: ${error.message}`);
  if (!data?.length) return fail("Mailbox not found.");
  await audit(p, a, "settings", {
    detail: { op: "mailbox", id: i.id, mailbox: data[0].mailbox, ...patch },
  });
  return { ok: true as const };
}

// ------------------------------------------------------ 16 / 17 / 18 admin ops

export async function runSweepNow(p: Ports, a: Actor) {
  const result = await p.runTick();
  await audit(p, a, "settings", { detail: { op: "sweep_now", result } });
  return result;
}

const FILE_KEYS: Record<string, keyof DesktopFiles> = {
  "customer-mapping.csv": "mappingCsv",
  "learned-routing.json": "learnedJson",
  "context-rules.json": "contextRulesJson",
  "internal-routes.json": "internalRoutesJson",
  "multi-routes.json": "multiRoutesJson",
  "mail-notes.json": "mailNotesJson",
  "processed.log": "ledgerLog",
  "config.json": "configJson",
};
export const IMPORT_MAX_BYTES = 15 * 1024 * 1024;

export async function importDesktop(
  p: Ports,
  a: Actor,
  i: { files: Array<{ name: string; text: string }>; removeLearned?: string[]; apply: boolean },
) {
  const total = i.files.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0);
  if (total > IMPORT_MAX_BYTES) return fail("Files are larger than 15 MB in total.");
  const files: DesktopFiles = {};
  const unknown: string[] = [];
  for (const f of i.files) {
    const k = FILE_KEYS[f.name.split(/[\\/]/).pop()!.toLowerCase()];
    if (k) files[k] = f.text;
    else unknown.push(f.name);
  }
  if (unknown.length) return fail(...unknown.map((n) => `Unrecognised file '${n}'.`));
  const remove: Array<{ bucket: "sender" | "domain"; key: string }> = [];
  for (const r of i.removeLearned ?? []) {
    const m = /^(sender|domain):(.+)$/i.exec(r.trim());
    if (!m)
      return fail(`removeLearned entry '${r}' must look like sender:x@y.com or domain:y.com.`);
    remove.push({
      bucket: m[1].toLowerCase() as "sender" | "domain",
      key: m[2].trim().toLowerCase(),
    });
  }
  const plan = buildImportPlan(files, { removeLearned: remove });
  if (!i.apply)
    return { ok: true as const, applied: false, counts: plan.counts, warnings: plan.warnings };
  // removeLearned is NOT passed to applyImportPlan (it would DELETE rows); listed entries are marked forgotten instead.
  const counts = await p.applyImportPlan(plan, { userId: a.id, userName: a.name, source: "web" }); // writes its own 'import' action
  let forgotten = 0;
  for (const r of remove) {
    const { data } = await p.db
      .from("archiver_learned")
      .update({ source: "forgotten", updated_at: new Date().toISOString() })
      .eq("bucket", r.bucket)
      .eq("key", r.key)
      .select("key");
    forgotten += data?.length ?? 0;
  }
  return { ok: true as const, applied: true, counts, forgotten, warnings: plan.warnings };
}

export async function probeArchive(p: Ports, a: Actor) {
  const { data: open } = await p.db
    .from("p21_bridge_jobs")
    .select("id, status")
    .eq("kind", "archive.probe")
    .in("status", ["pending", "claimed"])
    .order("created_at")
    .limit(1);
  if (open?.length) return { id: open[0].id as string, existing: true };
  const { data, error } = await p.db
    .from("p21_bridge_jobs")
    .insert({ kind: "archive.probe", payload: {}, created_by: a.id })
    .select("id")
    .single();
  if (error) throw new Error(`probe enqueue failed: ${error.message}`);
  await audit(p, a, "settings", { detail: { op: "probe", job_id: data.id } });
  return { id: data.id as string, existing: false };
}
