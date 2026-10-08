/**
 * Order Mail tick: called every minute from /api/public/run-sql-schedules.
 * Dormant (returns skipped) until Microsoft Graph credentials exist AND a
 * mailbox row is enabled. Never throws to the caller.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { GraphClient, type GraphAuth } from "./graph";
import { sweepMailbox, type SweepCounts } from "./sweep";
import { listEnabledMailboxes, supabaseSweepStore } from "./sweep-store.server";

const db = supabaseAdmin as any;
const LOCK_KEY = "archiver_lock";
const LOCK_TTL_MS = 4 * 60_000;

export async function getArchiverSettings(): Promise<Record<string, unknown>> {
  const { data } = await db.from("app_settings").select("value").eq("key", "archiver").maybeSingle();
  return (data?.value ?? {}) as Record<string, unknown>;
}

/** settings.graph_auth: "gateway" (default; Lovable Microsoft Outlook connector) or "app" (Entra app, client credentials). */
export function resolveGraphAuth(settings: Record<string, unknown>, env: Record<string, string | undefined> = process.env): GraphAuth | null {
  if (settings.graph_auth === "app") {
    const tenantId = env.ARCHIVER_GRAPH_TENANT_ID, clientId = env.ARCHIVER_GRAPH_CLIENT_ID, clientSecret = env.ARCHIVER_GRAPH_CLIENT_SECRET;
    return tenantId && clientId && clientSecret ? { kind: "app", tenantId, clientId, clientSecret } : null;
  }
  const lovableKey = env.LOVABLE_API_KEY, connectionKey = env.MICROSOFT_OUTLOOK_API_KEY;
  return lovableKey && connectionKey ? { kind: "gateway", lovableKey, connectionKey, connectorId: "microsoft_outlook" } : null;
}

export function graphStatus(settings: Record<string, unknown>) {
  const auth = resolveGraphAuth(settings);
  return { configured: !!auth, mode: (settings.graph_auth === "app" ? "app" : "gateway") as "app" | "gateway" };
}

/** Compare-and-set lock on app_settings: one sweep at a time across overlapping cron ticks and manual runs. */
async function acquireLock(holder: string, now: Date): Promise<boolean> {
  await db.from("app_settings").upsert({ key: LOCK_KEY, value: { holder: "", at: null }, updated_at: new Date(0).toISOString() },
    { onConflict: "key", ignoreDuplicates: true });
  const cutoff = new Date(now.getTime() - LOCK_TTL_MS).toISOString();
  const { data, error } = await db.from("app_settings")
    .update({ value: { holder, at: now.toISOString() }, updated_at: now.toISOString() })
    .eq("key", LOCK_KEY).lt("updated_at", cutoff).select("key");
  if (error) throw new Error(`lock failed: ${error.message}`);
  return !!data && data.length === 1;
}
async function releaseLock(holder: string) {
  await db.from("app_settings").update({ value: { holder: "", at: null }, updated_at: new Date(0).toISOString() })
    .eq("key", LOCK_KEY).eq("value->>holder", holder);
}

export async function runArchiverTick(now = new Date(), trigger: "cron" | "manual" = "cron") {
  try {
    const settings = await getArchiverSettings();
    if (settings.paused === true) return { ok: true, skipped: "paused" };
    const auth = resolveGraphAuth(settings);
    if (!auth) return { ok: true, skipped: "graph_not_configured" };
    const mailboxes = await listEnabledMailboxes();
    if (!mailboxes.length) return { ok: true, skipped: "no_enabled_mailbox" };
    const holder = `${trigger}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await acquireLock(holder, now))) return { ok: true, skipped: "locked" };
    const results: Array<{ mailbox: string; counts?: SweepCounts; error?: string }> = [];
    try {
      const graph = new GraphClient(auth);
      for (const mb of mailboxes) {
        const startedAt = new Date().toISOString();
        const mode = settings.mode === "live" && settings.filing_enabled === true ? "live" : "shadow";
        try {
          const counts = await sweepMailbox(mb, { store: supabaseSweepStore, graph, settings, now });
          results.push({ mailbox: mb.mailbox, counts });
          await db.from("archiver_mailboxes").update({ last_sweep_at: now.toISOString(), last_error: null }).eq("id", mb.id);
          if (counts.classified > 0 || counts.excluded > 0 || trigger === "manual") {
            await db.from("archiver_runs").insert({ mailbox_id: mb.id, trigger, mode, started_at: startedAt,
              ended_at: new Date().toISOString(), status: "ok", counts });
          }
        } catch (e: any) {
          const message = String(e?.message ?? e).slice(0, 1000);
          results.push({ mailbox: mb.mailbox, error: message });
          await db.from("archiver_mailboxes").update({ last_error: message, last_sweep_at: now.toISOString() }).eq("id", mb.id);
          await db.from("archiver_runs").insert({ mailbox_id: mb.id, trigger, mode, started_at: startedAt,
            ended_at: new Date().toISOString(), status: "error", error: message });
        }
      }
    } finally {
      await releaseLock(holder);
    }
    return { ok: results.every((r) => !r.error), results };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
