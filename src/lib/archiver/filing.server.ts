/**
 * Order Mail filing — server side (service role). Live mode only:
 *   onLiveDecision      MIME -> private bucket -> archiver_filings + file.save jobs
 *   reconcileFilings    job results -> filings -> message status, ledger, Outlook marker, learning
 *   performAction       Wrong team? / Archive / Restore / Also file to -> file.move jobs + learning
 *   syncDesktopLedger   shadow comparison: read the desktop processed.log through the agent
 *   purgeOldMime        retention for the private bucket
 * Every function is idempotent: filings carry a unique idempotency_key and the
 * agent replays a completed key instead of writing a second file.
 */
import { createHash } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildClassifyConfig, isFreeMailDomain, promoteLearnedDomains, type Decision, type LearnedStore } from "./classify";
import { GraphClient, type GraphMessageMeta } from "./graph";
import { parseLedger } from "./import-desktop";
import { mailboxBase, destinationToTeam, type MessageRow } from "./sweep";
import {
  ledgerDestination, learnFromFiling, learnFromHuman, messageStatusFromFilings, planAction, planFilings, planRestore, storagePathFor,
  type HumanAction, type TeamRow,
} from "./filing";

const db = supabaseAdmin as any;
const BUCKET = "archiver-mail";
const SIGNED_URL_SECONDS = 24 * 3600;

async function teamsMap(): Promise<Map<string, TeamRow>> {
  const { data, error } = await db.from("archiver_teams").select("key, folder_path, kind");
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((t: TeamRow) => [t.key, t]));
}

async function enqueue(kind: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from("p21_bridge_jobs").insert({ kind, payload }).select("id").single();
  if (error) throw new Error(`enqueue ${kind} failed: ${error.message}`);
  return data.id as string;
}

async function signedUrl(path: string): Promise<string> {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) throw new Error(`signed URL failed: ${error?.message ?? "none"}`);
  return data.signedUrl as string;
}

// ------------------------------------------------------------------ live filing

export function makeOnLiveDecision(graph: GraphClient, mailbox: string) {
  return async (messageId: string, row: MessageRow, _meta: GraphMessageMeta, d: Decision) => {
    const base = mailboxBase(mailbox);
    const mime = Buffer.from(await graph.getMime(base, row.graph_id));
    const sha = createHash("sha256").update(mime).digest("hex");
    const path = storagePathFor(messageId, row.received_at);
    const up = await db.storage.from(BUCKET).upload(path, mime, { contentType: "message/rfc822", upsert: true });
    if (up.error) throw new Error(`MIME upload failed: ${up.error.message}`);
    await db.from("archiver_messages").update({ storage_path: path, size_bytes: mime.length, updated_at: new Date().toISOString() }).eq("id", messageId);
    const plans = planFilings(messageId, d, await teamsMap());
    const url = await signedUrl(path);
    for (const p of plans) {
      const jobId = await enqueue("file.save", {
        idempotencyKey: p.idempotency_key, relDir: p.rel_path, stem: d.stem, ext: ".eml", url, sha256: sha, bytes: mime.length,
        receivedAt: row.received_at, storagePath: path,
      });
      const { error } = await db.from("archiver_filings").upsert({
        message_id: messageId, team_key: p.team_key, kind: p.kind, rel_path: p.rel_path, file_name: p.file_name,
        idempotency_key: p.idempotency_key, bridge_job_id: jobId, status: "queued",
      }, { onConflict: "idempotency_key", ignoreDuplicates: true });
      if (error) throw new Error(`filing insert failed: ${error.message}`);
    }
  };
}

/**
 * Live emails whose filing setup failed part-way (MIME fetch, upload or enqueue error):
 * status 'queued' with no filings, older than 3 minutes. Re-run the setup from the stored decision.
 */
export async function retryOrphans(graph: GraphClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - 3 * 60_000).toISOString();
  const { data: msgs } = await db.from("archiver_messages").select("*").eq("status", "queued").eq("mode", "live").lt("created_at", cutoff).limit(25);
  let retried = 0;
  for (const m of msgs ?? []) {
    const { count } = await db.from("archiver_filings").select("id", { count: "exact", head: true }).eq("message_id", m.id);
    if ((count ?? 0) > 0) continue;
    const { data: mb } = await db.from("archiver_mailboxes").select("mailbox").eq("id", m.mailbox_id).single();
    const d = { customerKey: m.team_key, alsoCustomers: m.also_team_keys ?? [], stem: m.stem } as Decision;
    try {
      await makeOnLiveDecision(graph, mb.mailbox)(m.id, m as MessageRow, {} as GraphMessageMeta, d);
      retried++;
    } catch (e: any) {
      await db.from("archiver_messages").update({ ambiguity: `filing setup failed, will retry: ${String(e?.message ?? e).slice(0, 200)}` }).eq("id", m.id);
    }
  }
  return { retried };
}

// ---------------------------------------------------------------- reconcile

export async function reconcileFilings(now = new Date(), graph: GraphClient | null = null) {
  const counts = { done: 0, error: 0, requeued: 0, filed_messages: 0, marked: 0, learned: 0 };
  const { data: open, error } = await db.from("archiver_filings")
    .select("id, message_id, team_key, kind, rel_path, idempotency_key, bridge_job_id, status, created_at")
    .eq("status", "queued").limit(500);
  if (error) throw new Error(error.message);
  if (!open?.length) return counts;
  const jobIds = open.map((f: any) => f.bridge_job_id).filter(Boolean);
  const { data: jobs } = await db.from("p21_bridge_jobs").select("id, kind, status, result, error, payload, claimed_at, created_at").in("id", jobIds);
  const byJob = new Map((jobs ?? []).map((j: any) => [j.id, j]));
  const touched = new Set<string>();

  for (const f of open) {
    const j: any = byJob.get(f.bridge_job_id);
    if (!j) continue;
    if (j.status === "done") {
      await db.from("archiver_filings").update({ status: "done", written_path: j.result?.relPath ?? null, sha256: j.result?.sha256 ?? null,
        bytes: j.result?.bytes ?? null, completed_at: now.toISOString(), error: null }).eq("id", f.id);
      if (j.payload?.supersedes) await db.from("archiver_filings").update({ status: "superseded" }).eq("id", j.payload.supersedes);
      counts.done++; touched.add(f.message_id);
    } else if (j.status === "error") {
      await db.from("archiver_filings").update({ status: "error", error: String(j.error ?? "agent error").slice(0, 1000) }).eq("id", f.id);
      counts.error++; touched.add(f.message_id);
    } else if (j.status === "claimed" && j.claimed_at && now.getTime() - Date.parse(j.claimed_at) > 15 * 60_000) {
      // The agent took it and went quiet. Re-queue with the same idempotency key: if the first
      // attempt actually finished, the agent replays its result instead of writing again.
      await db.from("p21_bridge_jobs").update({ status: "error", error: "stale: claimed > 15 min without completion", completed_at: now.toISOString() }).eq("id", j.id);
      const payload = { ...j.payload };
      if (j.kind === "file.save" && payload.storagePath) payload.url = await signedUrl(payload.storagePath);
      const newId = await enqueue(j.kind, payload);
      await db.from("archiver_filings").update({ bridge_job_id: newId }).eq("id", f.id);
      counts.requeued++;
    } else if (j.status === "pending" && j.kind === "file.save" && now.getTime() - Date.parse(j.created_at) > 20 * 3600_000) {
      // Agent offline for most of a day: refresh the signed URL before it expires.
      await db.from("p21_bridge_jobs").update({ payload: { ...j.payload, url: await signedUrl(j.payload.storagePath) } }).eq("id", j.id).eq("status", "pending");
    }
  }

  const settings = await getSettings();
  for (const messageId of touched) {
    const r = await afterFilingChange(messageId, settings, graph, now);
    if (r.filedNow) counts.filed_messages++;
    if (r.marked) counts.marked++;
    if (r.learned) counts.learned++;
  }
  return counts;
}

async function getSettings(): Promise<Record<string, unknown>> {
  const { data } = await db.from("app_settings").select("value").eq("key", "archiver").maybeSingle();
  return (data?.value ?? {}) as Record<string, unknown>;
}

async function afterFilingChange(messageId: string, settings: Record<string, unknown>, graph: GraphClient | null, now: Date) {
  const out = { filedNow: false, marked: false, learned: false };
  const { data: msg } = await db.from("archiver_messages").select("*").eq("id", messageId).single();
  const { data: filings } = await db.from("archiver_filings").select("kind, status, team_key, rel_path, written_path").eq("message_id", messageId);
  const status = messageStatusFromFilings(filings ?? []);
  if (status === msg.status) return out;
  await db.from("archiver_messages").update({ status, updated_at: now.toISOString() }).eq("id", messageId);
  if (status !== "filed" || msg.status !== "queued") return out;
  out.filedNow = true;

  // Ledger first (the "already filed" record), exactly like the desktop: files on disk -> ledger -> marker.
  const done = (filings ?? []).filter((f: any) => f.status === "done");
  const primary = done.find((f: any) => f.kind === "primary");
  await db.from("archiver_ledger").upsert({
    key: msg.ledger_key, entry_id: msg.graph_id ?? "", stem: msg.stem ?? "",
    destination: ledgerDestination(primary?.rel_path ?? "", done.filter((f: any) => f.kind === "copy").map((f: any) => f.rel_path)),
    filed_at: msg.received_local, host: "nelson", user_name: "order-mail", source: "web",
  }, { onConflict: "key" });

  const marker = String(settings.processed_marker ?? "flag") as "flag" | "category" | "both" | "none";
  if (graph && marker !== "none" && msg.graph_id) {
    try {
      const { data: mb } = await db.from("archiver_mailboxes").select("mailbox").eq("id", msg.mailbox_id).single();
      await graph.markProcessed(mailboxBase(mb.mailbox), msg.graph_id, marker, String(settings.processed_category ?? "Archived"));
      await db.from("archiver_messages").update({ outlook_marked_at: now.toISOString() }).eq("id", messageId);
      out.marked = true;
    } catch (e: any) {
      // Filed and in the ledger; only the marker failed. The ledger stops a re-file.
      await db.from("archiver_messages").update({ ambiguity: `filed; Outlook marker failed: ${String(e?.message ?? e).slice(0, 200)}` }).eq("id", messageId);
    }
  }

  if (settings.learning_enabled !== false && msg.team_key && msg.route_source) {
    out.learned = await applyAutoLearning(msg, settings, now);
  }
  await bumpRuleHits(msg);
  return out;
}

// ---------------------------------------------------------------- learning

async function loadLearnedFor(addr: string): Promise<{ store: LearnedStore; domain: string }> {
  const domain = addr.includes("@") ? addr.split("@").pop()! : "";
  const cols = "bucket, key, team_key, count, source, first_at, last_at, root, run";
  const { data: s } = await db.from("archiver_learned").select(cols).eq("bucket", "sender").eq("key", addr);
  const { data: d } = domain ? await db.from("archiver_learned").select(cols).eq("bucket", "domain").eq("key", domain) : { data: [] };
  const data = [...(s ?? []), ...(d ?? [])];
  const store: LearnedStore = { senders: {}, domains: {} };
  for (const r of data) (r.bucket === "sender" ? store.senders : store.domains)[r.key] =
    { customer: r.team_key, count: r.count, source: r.source, first: r.first_at, last: r.last_at, root: r.root, run: r.run };
  return { store, domain };
}

async function saveLearned(store: LearnedStore) {
  const rows = [
    ...Object.entries(store.senders).map(([key, e]) => ({ bucket: "sender", key, e })),
    ...Object.entries(store.domains).map(([key, e]) => ({ bucket: "domain", key, e })),
  ].map(({ bucket, key, e }) => ({ bucket, key: key.toLowerCase(), team_key: e.customer, count: e.count, source: e.source,
    first_at: e.first ?? "", last_at: e.last ?? "", root: e.root ?? "", run: e.run ?? "", updated_at: new Date().toISOString() }));
  if (rows.length) {
    const { error } = await db.from("archiver_learned").upsert(rows, { onConflict: "bucket,key" });
    if (error) throw new Error(`learned upsert failed: ${error.message}`);
  }
}

async function maybePromote(domain: string, settings: Record<string, unknown>) {
  if (!domain) return [];
  const cfg = buildClassifyConfig(settings);
  const { data: senders } = await db.from("archiver_learned").select("key, team_key, count, source").eq("bucket", "sender").like("key", `%@${domain}`);
  const { data: dom } = await db.from("archiver_learned").select("key, team_key, count, source").eq("bucket", "domain").eq("key", domain);
  const { data: teams } = await db.from("archiver_teams").select("key, display_name, folder_path, sender_domains, keywords").eq("kind", "team");
  const store: LearnedStore = { senders: {}, domains: {} };
  for (const s of senders ?? []) store.senders[s.key] = { customer: s.team_key, count: s.count, source: s.source };
  for (const d of dom ?? []) store.domains[d.key] = { customer: d.team_key, count: d.count, source: d.source };
  const mapping = (teams ?? []).map((t: any) => ({ customerKey: t.key, displayName: t.display_name, folderPath: t.folder_path,
    senderDomains: [...(t.sender_domains ?? [])], keywords: t.keywords ?? [] }));
  const r = promoteLearnedDomains(store, mapping, { promoteAfter: Number(settings.learn_promote_after ?? 3) || 3,
    ignoredDomains: cfg.ignoredDomains, neverLearn: cfg.neverContext, multiTerritory: cfg.multiTerritory });
  for (const p of r.promoted) {
    const row = mapping.find((m: any) => m.customerKey === p.customer)!;
    await db.from("archiver_teams").update({ sender_domains: row.senderDomains, updated_at: new Date().toISOString() }).eq("key", p.customer);
    await db.from("archiver_actions").insert({ action: "settings", user_name: "order-mail learning", detail: { promoted: p } });
  }
  return r.promoted;
}

async function applyAutoLearning(msg: any, settings: Record<string, unknown>, now: Date): Promise<boolean> {
  const cfg = buildClassifyConfig(settings);
  const addr = String(msg.sender_address ?? "").toLowerCase();
  const { store, domain } = await loadLearnedFor(addr);
  const r = learnFromFiling(store, { senderAddress: addr, customerKey: msg.team_key, confidence: Number(msg.confidence), matchSource: msg.route_source },
    { ignoredDomains: cfg.ignoredDomains, neverLearn: cfg.neverContext, multiTerritory: cfg.multiTerritory, contentOnly: cfg.contentOnly,
      now: now.toISOString().slice(0, 19), runId: `web-${now.toISOString().slice(0, 10)}` });
  if (!r.changed) return false;
  await saveLearned(store);
  await maybePromote(domain, settings);
  return true;
}

async function bumpRuleHits(msg: any) {
  if (!msg.rule_id) return;
  if (msg.route_source === "multi-route") {
    const { data } = await db.from("archiver_multi_routes").select("hits").eq("id", msg.rule_id).maybeSingle();
    if (data) await db.from("archiver_multi_routes").update({ hits: (data.hits ?? 0) + 1 }).eq("id", msg.rule_id);
  } else if (String(msg.route_source).startsWith("context-rule")) {
    const { data } = await db.from("archiver_content_rules").select("hits").eq("id", msg.rule_id).maybeSingle();
    if (data) await db.from("archiver_content_rules").update({ hits: (data.hits ?? 0) + 1, last_hit_at: new Date().toISOString() }).eq("id", msg.rule_id);
  }
}

// ----------------------------------------------------------- human actions

export async function performAction(messageId: string, act: HumanAction | { action: "restore"; toTeam: string }, user: { id: string; name: string }) {
  const now = new Date();
  const stamp = String(now.getTime());
  const { data: msg, error } = await db.from("archiver_messages").select("*").eq("id", messageId).single();
  if (error || !msg) throw new Error("email not found");
  const settings = await getSettings();
  const teams = await teamsMap();
  const { data: filings } = await db.from("archiver_filings").select("id, team_key, kind, written_path, status").eq("message_id", messageId);
  const files = (filings ?? []).map((f: any) => ({ filing_id: f.id, team_key: f.team_key, kind: f.kind, written_path: f.written_path, status: f.status }));
  const moves = act.action === "restore" && "toTeam" in act
    ? planRestore(messageId, files, act.toTeam, teams, stamp)
    : planAction(messageId, act as HumanAction, files, teams, stamp);

  for (const m of moves) {
    const jobId = await enqueue("file.move", { idempotencyKey: m.idempotency_key, fromRelPath: m.fromRelPath, toRelDir: m.toRelDir,
      mode: m.mode, receivedAt: msg.received_at, supersedes: m.supersedes || null });
    await db.from("archiver_filings").insert({ message_id: messageId, team_key: m.team_key, kind: m.kind, rel_path: m.toRelDir,
      file_name: m.fromRelPath.split("/").pop(), idempotency_key: m.idempotency_key, bridge_job_id: jobId, status: "queued" });
  }

  const fromTeam = msg.team_key;
  const patch: Record<string, unknown> = { updated_at: now.toISOString() };
  if (act.action === "wrong_team") patch.team_key = act.toTeam;
  if (act.action === "restore" && "toTeam" in act) patch.team_key = act.toTeam;
  if (act.action === "also_file") patch.also_team_keys = Array.from(new Set([...(msg.also_team_keys ?? []), ...act.teams]));
  if (moves.length) patch.status = "queued";
  await db.from("archiver_messages").update(patch).eq("id", messageId);

  let learned: Array<{ bucket: string; key: string }> = [];
  if (act.action === "wrong_team" && settings.learning_enabled !== false) {
    const cfg = buildClassifyConfig(settings);
    const { store, domain } = await loadLearnedFor(String(msg.sender_address ?? "").toLowerCase());
    learned = learnFromHuman(store, msg.sender_address, act.toTeam, fromTeam === "UNROUTED" ? "taught" : "corrected",
      { contentOnly: cfg.contentOnly, ignoredDomains: cfg.ignoredDomains, multiTerritory: cfg.multiTerritory, freeMail: isFreeMailDomain,
        now: now.toISOString().slice(0, 19) });
    if (learned.length) { await saveLearned(store); await maybePromote(domain, settings); }
  }
  await db.from("archiver_actions").insert({ message_id: messageId, user_id: user.id, user_name: user.name, action: act.action,
    from_team: fromTeam, to_team: "toTeam" in act ? act.toTeam : act.action === "archive" ? "IGNORED" : null,
    team_keys: act.action === "also_file" ? act.teams : [], detail: { jobs: moves.length, learned } });
  return { jobs: moves.length, learned };
}

// ------------------------------------------------- shadow: desktop ledger sync

/** Every ~10 minutes: read new lines of the desktop processed.log through the agent and back-fill desktop_team_key. */
export async function syncDesktopLedger(now = new Date()) {
  const { data: st } = await db.from("app_settings").select("value").eq("key", "archiver_ledger_sync").maybeSingle();
  const state = (st?.value ?? { fromByte: 0, jobId: null, lastAt: null }) as { fromByte: number; jobId: string | null; lastAt: string | null };
  if (state.jobId) {
    const { data: job } = await db.from("p21_bridge_jobs").select("status, result, error").eq("id", state.jobId).maybeSingle();
    if (!job || job.status === "pending" || job.status === "claimed") return { waiting: true };
    let applied = 0;
    if (job.status === "done" && job.result) {
      const rows = parseLedger(String(job.result.text ?? "")).map((r) => ({ key: r.key, entry_id: r.entryId, stem: r.stem, destination: r.destination,
        filed_at: r.at, host: r.host, user_name: r.user, source: "desktop" }));
      for (let i = 0; i < rows.length; i += 500) await db.from("archiver_ledger").upsert(rows.slice(i, i + 500), { onConflict: "key" });
      applied = rows.length;
      const { data: teams } = await db.from("archiver_teams").select("key, folder_path");
      const byFolder = new Map<string, string>((teams ?? []).map((t: any) => [String(t.folder_path).toLowerCase(), String(t.key)]));
      const keys = rows.map((r) => r.key);
      for (let i = 0; i < keys.length; i += 100) {
        const { data: msgs } = await db.from("archiver_messages").select("id, ledger_key").in("ledger_key", keys.slice(i, i + 100)).is("desktop_team_key", null);
        for (const m of msgs ?? []) {
          const dest = rows.find((r) => r.key === m.ledger_key)?.destination ?? "";
          const team = destinationToTeam(dest, byFolder);
          if (team) await db.from("archiver_messages").update({ desktop_team_key: team }).eq("id", m.id);
        }
      }
      const next = { fromByte: job.result.toByte ?? state.fromByte, jobId: null, lastAt: now.toISOString() };
      await db.from("app_settings").upsert({ key: "archiver_ledger_sync", value: next, updated_at: now.toISOString() }, { onConflict: "key" });
      if ((job.result.toByte ?? 0) < (job.result.size ?? 0)) return { applied, more: true };
      return { applied };
    }
    await db.from("app_settings").upsert({ key: "archiver_ledger_sync", value: { ...state, jobId: null, lastAt: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" });
    return { error: job.error };
  }
  if (state.lastAt && now.getTime() - Date.parse(state.lastAt) < 10 * 60_000) return { skipped: "recent" };
  const jobId = await enqueue("archive.ledger.read", { fromByte: state.fromByte ?? 0, maxBytes: 512 * 1024 });
  await db.from("app_settings").upsert({ key: "archiver_ledger_sync", value: { ...state, jobId }, updated_at: now.toISOString() }, { onConflict: "key" });
  return { enqueued: jobId };
}

// --------------------------------------------------------------- retention

export async function purgeOldMime(now = new Date()) {
  const settings = await getSettings();
  const days = Math.max(7, Number(settings.retention_days ?? 90) || 90);
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
  const { data } = await db.from("archiver_messages").select("id, storage_path").not("storage_path", "is", null)
    .lt("received_at", cutoff).in("status", ["filed", "archived", "ignored"]).limit(200);
  const paths = (data ?? []).map((m: any) => m.storage_path);
  if (!paths.length) return { removed: 0 };
  const { error } = await db.storage.from(BUCKET).remove(paths);
  if (error) throw new Error(`purge failed: ${error.message}`);
  await db.from("archiver_messages").update({ storage_path: null }).in("id", (data ?? []).map((m: any) => m.id));
  return { removed: paths.length };
}
