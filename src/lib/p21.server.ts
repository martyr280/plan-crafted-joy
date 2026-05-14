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
      birm: r.Birm ?? null,
      dallas: r.Dallas ?? null,
      ocala: r.Ocala ?? null,
      total: r.Total ?? null,
      e2g_price: r["E2G Price"] ?? null,
      weight: r.weight ?? null,
      net_weight: r.net_weight ?? null,
      next_due_date: nextDate,
      next_due_in_display: r["Next Due In"] || null,
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
