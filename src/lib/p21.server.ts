import { supabaseAdmin } from "@/integrations/supabase/client.server";

export async function assertAdmin(supabase: any, userId: string) {
  const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const isAdmin = (roles ?? []).some((r: any) => r.role === "admin");
  if (!isAdmin) throw new Error("Admin role required");
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

  const toInsert = rows.map((r) => {
    const rawDate = r.next_due_date;
    let nextDate: string | null = null;
    if (rawDate) {
      const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (!Number.isNaN(d.getTime())) nextDate = d.toISOString().slice(0, 10);
    }
    return {
      item_id: String(r.item_id),
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

const normSku = (s: string) => String(s ?? "").toUpperCase().replace(/\s+/g, "");

export async function applyE2GToPriceList(): Promise<{ updated: number; inserted: number; flaggedMissing: number }> {
  // Pull all E2G snapshot rows
  const e2gRows: Array<{ item_id: string; item_desc: string | null; e2g_price: number | null; weight: number | null }> = [];
  {
    const step = 1000;
    for (let from = 0; ; from += step) {
      const { data, error } = await supabaseAdmin
        .from("e2g_inventory_snapshot")
        .select("item_id, item_desc, e2g_price, weight")
        .range(from, from + step - 1);
      if (error) throw new Error(`E2G read failed: ${error.message}`);
      e2gRows.push(...((data ?? []) as any));
      if (!data || data.length < step) break;
    }
  }

  // Pull all existing pricer rows
  const pricerRows: Array<{ id: string; item: string }> = [];
  {
    const step = 1000;
    for (let from = 0; ; from += step) {
      const { data, error } = await supabaseAdmin
        .from("price_list")
        .select("id, item")
        .range(from, from + step - 1);
      if (error) throw new Error(`price_list read failed: ${error.message}`);
      pricerRows.push(...((data ?? []) as any));
      if (!data || data.length < step) break;
    }
  }

  const pricerByKey = new Map<string, string>(); // normSku -> id
  for (const r of pricerRows) pricerByKey.set(normSku(r.item), r.id);

  const now = new Date().toISOString();
  const updates: Array<{ id: string; description: string | null; e2g_price: number | null; e2g_weight: number | null }> = [];
  const inserts: Array<{ item: string; description: string | null; e2g_price: number | null; e2g_weight: number | null; in_e2g: boolean; e2g_synced_at: string; source: string }> = [];
  const e2gKeys = new Set<string>();

  for (const r of e2gRows) {
    const key = normSku(r.item_id);
    if (!key) continue;
    e2gKeys.add(key);
    const id = pricerByKey.get(key);
    if (id) {
      updates.push({ id, description: r.item_desc, e2g_price: r.e2g_price, e2g_weight: r.weight });
    } else {
      inserts.push({
        item: r.item_id,
        description: r.item_desc,
        e2g_price: r.e2g_price,
        e2g_weight: r.weight,
        in_e2g: true,
        e2g_synced_at: now,
        source: "e2g_p21",
      });
    }
  }

  // Apply updates one row at a time but in parallel batches of 50
  let updated = 0;
  const concurrency = 25;
  for (let i = 0; i < updates.length; i += concurrency) {
    const slice = updates.slice(i, i + concurrency);
    await Promise.all(
      slice.map(async (u) => {
        const { error } = await supabaseAdmin
          .from("price_list")
          .update({
            description: u.description,
            e2g_price: u.e2g_price,
            e2g_weight: u.e2g_weight,
            in_e2g: true,
            e2g_synced_at: now,
          })
          .eq("id", u.id);
        if (error) throw new Error(`price_list update failed: ${error.message}`);
        updated++;
      }),
    );
  }

  // Bulk insert new rows in chunks of 500
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("price_list").insert(chunk);
    if (error) throw new Error(`price_list insert failed: ${error.message}`);
    inserted += chunk.length;
  }

  // Flag SKUs missing from E2G: set in_e2g = false in batches by id
  const missingIds = pricerRows.filter((p) => !e2gKeys.has(normSku(p.item))).map((p) => p.id);
  let flaggedMissing = 0;
  for (let i = 0; i < missingIds.length; i += 500) {
    const slice = missingIds.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("price_list").update({ in_e2g: false }).in("id", slice);
    if (error) throw new Error(`price_list flag-missing failed: ${error.message}`);
    flaggedMissing += slice.length;
  }

  return { updated, inserted, flaggedMissing };
}
