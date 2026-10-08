/**
 * Writes an import plan (importer.ts) into the Order Mail tables with the
 * service-role client. Idempotent: every table is upserted on its natural key.
 * Nothing is deleted except the learned entries named in plan options (the
 * caller decides; see removeLearned in buildImportPlan).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ImportPlan } from "./importer";

/** 'yyyy-MM-ddTHH:mm:ss' wall-clock in America/Chicago -> ISO UTC. Empty/invalid -> null. */
export function chicagoLocalToIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(local ?? ""));
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Offset of Chicago at that instant (two passes handle the DST edge).
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
  };
  let t = asUtc - offsetAt(asUtc);
  t = asUtc - offsetAt(t);
  return new Date(t).toISOString();
}

async function upsertBatches(table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await (supabaseAdmin as any).from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table} upsert failed at row ${i}: ${error.message}`);
  }
}

export async function applyImportPlan(
  plan: ImportPlan,
  actor: { userId?: string | null; userName: string; source: string; removeLearned?: Array<{ bucket: string; key: string }> },
) {
  const now = new Date().toISOString();
  if (plan.teams.length) {
    await upsertBatches("archiver_teams", plan.teams.map((t) => ({ ...t, updated_at: now })), "key");
  }
  if (plan.contentRules.length) {
    await upsertBatches("archiver_content_rules", plan.contentRules.map(({ created_local, ...r }) => ({
      ...r, created_at: chicagoLocalToIso(created_local) ?? now,
    })), "id");
  }
  if (plan.internalRoutes.length) {
    await upsertBatches("archiver_internal_routes", plan.internalRoutes.map(({ created_local, ...r }) => ({
      ...r, created_at: chicagoLocalToIso(created_local) ?? now,
    })), "address");
  }
  if (plan.multiRoutes.length) {
    await upsertBatches("archiver_multi_routes", plan.multiRoutes.map(({ created_local, ...r }) => ({
      ...r, created_at: chicagoLocalToIso(created_local) ?? now,
    })), "kind,value");
  }
  if (plan.learned.length) {
    await upsertBatches("archiver_learned", plan.learned.map((r) => ({ ...r, updated_at: now })), "bucket,key");
  }
  let learnedDeleted = 0;
  for (const r of actor.removeLearned ?? []) {
    const { data, error } = await (supabaseAdmin as any).from("archiver_learned").delete()
      .eq("bucket", r.bucket).eq("key", r.key.toLowerCase()).select("key");
    if (error) throw new Error(`learned delete failed for ${r.bucket} ${r.key}: ${error.message}`);
    learnedDeleted += (data ?? []).length;
  }
  if (plan.notes.length) {
    await upsertBatches("archiver_notes", plan.notes.map(({ done_at_local, ...n }) => ({
      ...n, done_at: chicagoLocalToIso(done_at_local), updated_at: now,
    })), "ledger_key");
  }
  if (plan.ledger.length) {
    await upsertBatches("archiver_ledger", plan.ledger, "key");
  }
  if (Object.keys(plan.settings).length) {
    const { data: cur } = await (supabaseAdmin as any).from("app_settings").select("value").eq("key", "archiver").maybeSingle();
    const value = { ...(cur?.value ?? {}), ...plan.settings };
    const { error } = await (supabaseAdmin as any).from("app_settings").upsert({ key: "archiver", value, updated_at: now }, { onConflict: "key" });
    if (error) throw new Error(`settings upsert failed: ${error.message}`);
  }
  const counts = { ...plan.counts, learned_deleted: learnedDeleted };
  await (supabaseAdmin as any).from("archiver_actions").insert({
    action: "import", user_id: actor.userId ?? null, user_name: actor.userName,
    detail: { source: actor.source, counts, warnings: plan.warnings },
  });
  return counts;
}
