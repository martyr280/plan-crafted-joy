import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

const EnqueueSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.string(), z.any()).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

async function assertAdmin(supabase: any, userId: string) {
  const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const isAdmin = (roles ?? []).some((r: any) => r.role === "admin");
  if (!isAdmin) throw new Error("Admin role required");
}

async function runJob(kind: string, payload: any, timeoutMs = 30000) {
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

export const enqueueP21Job = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => EnqueueSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    return runJob(data.kind, data.payload, data.timeoutMs);
  });

export const getBridgeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: agents } = await supabaseAdmin
      .from("p21_bridge_agents")
      .select("*")
      .order("last_seen_at", { ascending: false });
    const { data: pending } = await supabaseAdmin
      .from("p21_bridge_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    const { data: recent } = await supabaseAdmin
      .from("p21_bridge_jobs")
      .select("id, kind, status, created_at, completed_at, error")
      .order("created_at", { ascending: false })
      .limit(20);
    return { agents: agents ?? [], pendingCount: (pending as any)?.length ?? 0, recent: recent ?? [] };
  });

// ─── Predefined job kinds ─────────────────────────────────────────────────────

const SalesSchema = z.object({
  repCode: z.string().nullable().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const fetchSalesData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SalesSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
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
      { net: 0, orders: 0 }
    );

    // Cache for the "ALL" period so subsequent loads are instant.
    await supabaseAdmin.from("sales_cache").insert({
      rep_code: data.repCode ?? "ALL",
      period: "custom",
      date_from: data.dateFrom,
      date_to: data.dateTo,
      data: { rows, totals },
    });

    return { rows, totals, dateFrom: data.dateFrom, dateTo: data.dateTo };
  });

function bucketFor(daysPastDue: number): string {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1_30";
  if (daysPastDue <= 60) return "31_60";
  if (daysPastDue <= 90) return "61_90";
  return "90_plus";
}

export const syncArAging = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
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

    // Replace the snapshot: P21 is the source of truth for open AR.
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

    // Insert in chunks of 500 to avoid payload limits.
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error } = await supabaseAdmin.from("ar_aging").insert(toInsert.slice(i, i + 500));
      if (error) throw new Error(`AR insert failed: ${error.message}`);
    }

    return { imported: toInsert.length };
  });

const SubmitSchema = z.object({
  orderId: z.string().uuid(),
});

export const submitOrderToP21 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => SubmitSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    // Orders ops or admin can submit
    const { data: roles } = await context.supabase.from("user_roles").select("role").eq("user_id", userId);
    const allowed = (roles ?? []).some((r: any) => r.role === "admin" || r.role === "ops_orders");
    if (!allowed) throw new Error("Not authorized to submit orders");

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("id, customer_id, customer_name, po_number, line_items")
      .eq("id", data.orderId)
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
      60000
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
  });
