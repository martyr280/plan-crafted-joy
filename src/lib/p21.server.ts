// All server-side P21 helpers. This file is server-only by convention
// (`*.server.ts`) and must NEVER be imported at the top level of a module
// that is reachable from the client bundle. Import dynamically inside
// `createServerFn().handler(...)` bodies so the Vite splitter can strip
// the import along with the handler body.

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
      return { jobId: job.id as string, result: row.result };
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

// ─── Per-handler server-side bodies ──────────────────────────────────────────
// Each of these is the full server-side body for the matching createServerFn
// in p21.functions.ts. Keeping them here means p21.functions.ts never needs
// a top-level import of supabaseAdmin.

export async function getBridgeStatusServer() {
  const { data: agents } = await supabaseAdmin
    .from("p21_bridge_agents")
    .select("*")
    .order("last_seen_at", { ascending: false });
  const { data: recent } = await supabaseAdmin
    .from("p21_bridge_jobs")
    .select("id, kind, status, created_at, claimed_at, completed_at, error, payload, result")
    .order("created_at", { ascending: false })
    .limit(50);

  const counts = { pending: 0, claimed: 0, done: 0, error: 0 };
  for (const j of recent ?? []) {
    if (j.status in counts) (counts as any)[j.status]++;
  }

  const [{ count: pendingCount }, { count: failedCount }] = await Promise.all([
    supabaseAdmin.from("p21_bridge_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabaseAdmin.from("p21_bridge_jobs").select("id", { count: "exact", head: true }).eq("status", "error"),
  ]);

  return {
    agents: agents ?? [],
    pendingCount: pendingCount ?? 0,
    failedCount: failedCount ?? 0,
    recent: recent ?? [],
    counts,
  };
}

export async function retryBridgeJobServer(jobId: string): Promise<{ jobId: string }> {
  const { data: orig, error } = await supabaseAdmin
    .from("p21_bridge_jobs")
    .select("kind, payload")
    .eq("id", jobId)
    .single();
  if (error || !orig) throw new Error("Job not found");
  const { data: created, error: insErr } = await supabaseAdmin
    .from("p21_bridge_jobs")
    .insert({ kind: orig.kind, payload: orig.payload ?? {} })
    .select("id")
    .single();
  if (insErr || !created) throw new Error(insErr?.message ?? "Failed to requeue");
  return { jobId: created.id };
}

export async function fetchSalesDataServer(data: {
  repCode?: string | null;
  dateFrom: string;
  dateTo: string;
}) {
  const { result } = await runJob("sales.query", data, 60000);
  const rows = ((result as any)?.rows ?? []) as Array<{
    rep_code: string;
    customer_id: string;
    customer_name: string;
    net_sales: number;
    order_count: number;
  }>;

  const totals = rows.reduce(
    (acc, r) => {
      acc.net += Number(r.net_sales) || 0;
      acc.orders += Number(r.order_count) || 0;
      return acc;
    },
    { net: 0, orders: 0 },
  );

  await supabaseAdmin.from("sales_cache").insert({
    rep_code: data.repCode ?? "ALL",
    period: "custom",
    date_from: data.dateFrom,
    date_to: data.dateTo,
    data: { rows, totals },
  });

  return { rows, totals, dateFrom: data.dateFrom, dateTo: data.dateTo };
}

export async function syncArAgingServer() {
  const { result } = await runJob("ar.aging", {}, 60000);
  const rows = ((result as any)?.rows ?? []) as Array<{
    customer_id: string;
    customer_name: string;
    customer_email: string | null;
    invoice_number: string;
    amount_due: number;
    due_date: string;
    days_past_due: number;
  }>;

  if (rows.length === 0) return { imported: 0 };

  await supabaseAdmin.from("ar_aging").delete().neq("id", "00000000-0000-0000-0000-000000000000");

  const toInsert = rows.map((r) => ({
    customer_id: String(r.customer_id),
    customer_name: r.customer_name,
    customer_email: r.customer_email,
    invoice_number: String(r.invoice_number),
    amount_due: Number(r.amount_due),
    due_date: r.due_date,
    days_past_due: Number(r.days_past_due),
    bucket: bucketFor(Number(r.days_past_due)),
    collection_status: "none",
  }));

  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await supabaseAdmin.from("ar_aging").insert(toInsert.slice(i, i + 500));
    if (error) throw new Error(`AR insert failed: ${error.message}`);
  }

  return { imported: toInsert.length };
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

export async function submitOrderToP21Server(
  orderId: string,
  userId: string,
  userSupabase: any,
): Promise<{ p21OrderId: string }> {
  const { data: roles } = await userSupabase.from("user_roles").select("role").eq("user_id", userId);
  const allowed = (roles ?? []).some((r: any) => r.role === "admin" || r.role === "ops_orders");
  if (!allowed) throw new Error("Not authorized to submit orders");

  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, customer_name, po_number, line_items")
    .eq("id", orderId)
    .single();
  if (error || !order) throw new Error("Order not found");

  const lines = ((order.line_items as any[]) ?? []).map((li: any) => ({
    sku: li.sku,
    qty: Number(li.qty) || 0,
    unitPrice: Number(li.unit_price) || 0,
  }));

  const { result } = await runJob(
    "order.submit",
    { customerId: order.customer_id, poNumber: order.po_number, lines },
    60000,
  );

  const p21OrderId = (result as any)?.p21_order_id;
  if (!p21OrderId) throw new Error("Bridge did not return a P21 order id");

  await supabaseAdmin
    .from("orders")
    .update({
      status: "submitted_to_p21",
      p21_order_id: p21OrderId,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      p21_submitted_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  await supabaseAdmin.from("order_acknowledgements").insert({
    order_id: order.id,
    content: `Order ${p21OrderId} submitted to P21 for ${order.customer_name}.`,
  });

  await supabaseAdmin.from("activity_events").insert({
    event_type: "order.submitted",
    entity_type: "order",
    entity_id: p21OrderId,
    actor_id: userId,
    message: `Order ${p21OrderId} submitted to P21 (${order.customer_name})`,
  });

  return { p21OrderId };
}
