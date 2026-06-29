import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recomputeFamilies } from "./pricer.server";

const TRANSIENT_BACKEND_PATTERNS = [
  /schema cache/i,
  /retrying/i,
  /timeout/i,
  /timed out/i,
  /temporarily unavailable/i,
  /backend unreachable/i,
  /fetch failed/i,
  /network/i,
  /520|521|522|523|524/,
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isTransientBackendError(message: string) {
  return TRANSIENT_BACKEND_PATTERNS.some((pattern) => pattern.test(message));
}

export async function assertAdmin(_supabase: any, userId: string) {
  // Use service-role client + security-definer RPC so RLS on user_roles
  // can't mask the check (user-context reads may be filtered to zero rows).
  // Retry on transient backend/Data API errors (schema-cache reloads, gateway blips).
  let lastErrMsg = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { data, error } = await supabaseAdmin.rpc("has_role", {
        _user_id: userId,
        _role: "admin",
      });
      if (error) {
        lastErrMsg = error.message ?? String(error);
        if (!isTransientBackendError(lastErrMsg)) break;
      } else {
        if (!data) throw new Error("Admin role required");
        return;
      }
    } catch (e: any) {
      if (e?.message === "Admin role required") throw e;
      lastErrMsg = errorMessage(e);
      if (!isTransientBackendError(lastErrMsg)) break;
    }
    await sleep(Math.min(5000, 400 * 2 ** attempt));
  }
  const short = lastErrMsg.length > 200 ? lastErrMsg.slice(0, 200) + "…" : lastErrMsg;
  throw new Error(`Role check failed (backend unreachable): ${short}`);
}

export async function runJob(kind: string, payload: any, timeoutMs = 30000) {
  const { data: job, error } = await supabaseAdmin
    .from("p21_bridge_jobs")
    .insert({ kind, payload: payload ?? {} })
    .select("id")
    .single();
  if (error || !job) throw new Error(error?.message ?? "Failed to enqueue job");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: row } = await supabaseAdmin
      .from("p21_bridge_jobs")
      .select("status, result, error")
      .eq("id", job.id)
      .single();
    if (row && (row.status === "done" || row.status === "error")) {
      if (row.status === "error") throw new Error(row.error ?? "Bridge job failed");
      return { jobId: job.id, result: row.result };
    }
  }
  throw new Error("Bridge job timed out — is the agent running?");
}

export function bucketFor(daysPastDue: number): string {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1_30";
  if (daysPastDue <= 60) return "31_60";
  if (daysPastDue <= 90) return "61_90";
  return "90_plus";
}

export async function applyE2GSnapshot(timeoutMs = 90000): Promise<{ imported: number }> {
  const { result } = await runJob("e2g.combined-report", {}, timeoutMs);
  const rows = ((result as any)?.rows ?? []) as Array<Record<string, any>>;
  if (rows.length === 0) {
    await supabaseAdmin.from("e2g_inventory_snapshot").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    return { imported: 0 };
  }

  const num = (v: any): number | null => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[$,\s]/g, "");
    if (!/^-?\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const toIso = (v: any): string | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  const toInsert = rows.map((r) => {
    const rawDate = r.next_due_date;
    let nextDate: string | null = null;
    if (rawDate) {
      const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (!Number.isNaN(d.getTime())) nextDate = d.toISOString().slice(0, 10);
    }
    return {
      item_id: String(r.item_id),
      today: toIso(r.Today),
      item_desc: r.item_desc ?? null,
      birm: num(r.Birm),
      dallas: num(r.Dallas),
      ocala: num(r.Ocala),
      total: num(r.Total),
      e2g_price: num(r["E2G Price"]),
      weight: num(r.weight),
      net_weight: num(r.net_weight),
      next_due_date: nextDate,
      next_due_in_display: r["Next Due In"] != null ? String(r["Next Due In"]) : null,
      next_due_in_2: r["Next Due In 2"] != null ? String(r["Next Due In 2"]) : null,
    };
  });

  await supabaseAdmin
    .from("e2g_inventory_snapshot")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await supabaseAdmin
      .from("e2g_inventory_snapshot")
      .insert(toInsert.slice(i, i + 500));
    if (error) throw new Error(`E2G snapshot insert failed: ${error.message}`);
  }

  return { imported: toInsert.length };
}

export async function applyPricerSync(
  timeoutMs = 120000
): Promise<{ imported: number; removed: number; families_updated: number }> {
  const { result } = await runJob("pricer.sync", {}, timeoutMs);
  const rows = ((result as any)?.rows ?? []) as Array<Record<string, any>>;

  const num = (v: any): number | null => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[$,\s]/g, "");
    if (!/^-?\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const toUpsert = rows
    .filter((r) => r["Item #"] != null && String(r["Item #"]).trim() !== "")
    .map((r) => ({
      item: String(r["Item #"]).trim(),
      description: r["Description"] != null ? String(r["Description"]) : null,
      list_price: num(r["List Price"]),
      dealer_cost: num(r["Std Cost"]),
      price_l1: num(r["L1 Price"]),
      price_l2: num(r["L2 Price"]),
      price_l3: num(r["L3 Price"]),
      price_l4: num(r["L4 Price"]),
      price_l5: num(r["L5 Price"]),
      price_showroom: num(r["Showroom"]),
      mfg: r["Vendor"] != null ? String(r["Vendor"]) : null,
      cat_number: r["Vendor Part #"] != null ? String(r["Vendor Part #"]) : null,
      source: "p21_sql",
    }));

  // Deduplicate by item (unique index). Keep the first occurrence.
  const seen = new Set<string>();
  const dedup = [] as typeof toUpsert;
  for (const r of toUpsert) {
    if (seen.has(r.item)) continue;
    seen.add(r.item);
    dedup.push(r);
  }

  let imported = 0;
  for (let i = 0; i < dedup.length; i += 500) {
    const batch = dedup.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("price_list")
      .upsert(batch, { onConflict: "item" });
    if (error) throw new Error(`Pricer upsert failed: ${error.message}`);
    imported += batch.length;
  }

  // Remove p21_sql rows that no longer exist in the new pull.
  const keepItems = Array.from(seen);
  let removed = 0;
  // Fetch existing p21_sql rows in pages, compute diff client-side (item count
  // is moderate; this avoids huge .not("item", "in", "(...)") expressions).
  const { data: existing } = await supabaseAdmin
    .from("price_list")
    .select("item")
    .eq("source", "p21_sql")
    .limit(50000);
  const keepSet = new Set(keepItems);
  const toDelete = (existing ?? [])
    .map((r) => r.item as string)
    .filter((it) => !keepSet.has(it));
  for (let i = 0; i < toDelete.length; i += 500) {
    const batch = toDelete.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("price_list")
      .delete()
      .in("item", batch)
      .eq("source", "p21_sql");
    if (error) throw new Error(`Pricer cleanup failed: ${error.message}`);
    removed += batch.length;
  }

  const { updated: families_updated } = await recomputeFamilies();

  await supabaseAdmin.from("activity_events").insert({
    event_type: "pricer.synced",
    entity_type: "price_list",
    message: `Pricer synced from P21: ${imported} upserted, ${removed} removed, ${families_updated} families updated`,
    metadata: { imported, removed, families_updated },
  });

  return { imported, removed, families_updated };
}


