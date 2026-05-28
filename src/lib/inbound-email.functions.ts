import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classifyAndRouteInbound } from "@/lib/inbound-routing.server";
import { z } from "zod";

export const reprocessInboundEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    // Reset markers so the row goes through the full pipeline again.
    await supabaseAdmin
      .from("inbound_emails")
      .update({
        status: "received",
        error: null,
        created_record_type: null,
        created_record_id: null,
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    return await classifyAndRouteInbound(data.id);
  });

export const listInboundEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      status: z.string().optional(),
      classification: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }).parse,
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("inbound_emails")
      .select("id, from_addr, from_name, subject, classification, confidence, status, ai_summary, created_record_type, created_record_id, received_at, processed_at, error, referenced_order_id, change_type, is_internal")
      .order("received_at", { ascending: false })
      .limit(data.limit);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    if (data.classification && data.classification !== "all") q = q.eq("classification", data.classification);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

export const getInboundEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("inbound_emails").select("*").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    return row;
  });

export const reclassifyInboundEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    const { data: row } = await supabaseAdmin.from("inbound_emails").select("*").eq("id", data.id).single();
    if (!row) throw new Error("Not found");
    const url = `${process.env.SUPABASE_URL}/functions/v1/classify-inbound-email`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from_addr: row.from_addr, subject: row.subject, body_text: row.body_text }),
    });
    if (!r.ok) throw new Error(`classify ${r.status}`);
    const c = await r.json();
    await supabaseAdmin.from("inbound_emails").update({
      classification: c.classification,
      confidence: c.confidence,
      ai_summary: c.summary,
      ai_extracted: c.extracted ?? {},
      ai_flags: c.flags ?? [],
      status: "needs_review",
      reviewed_by: context.userId,
      reviewed_at: new Date().toISOString(),
    }).eq("id", data.id);
    return { ok: true, classification: c.classification, confidence: c.confidence };
  });

export const dismissInboundEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ id: z.string().uuid() }).parse)
  .handler(async ({ data, context }) => {
    await supabaseAdmin.from("inbound_emails").update({
      status: "dismissed",
      reviewed_by: context.userId,
      reviewed_at: new Date().toISOString(),
    }).eq("id", data.id);
    return { ok: true };
    return { ok: true };
  });

// Re-run parse-po against an order's source inbound email and overwrite the order's line items.
// Used to recover orders that came in with 0 line items because the first extraction missed the PDF.
export const reExtractOrderLineItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ orderId: z.string().uuid() }).parse)
  .handler(async ({ data }) => {
    const { data: order, error: oErr } = await supabaseAdmin
      .from("orders").select("id, raw_input").eq("id", data.orderId).single();
    if (oErr || !order) throw new Error(oErr?.message ?? "Order not found");

    // Find the linking inbound email (created_record_id = this order id).
    const { data: inbound } = await supabaseAdmin
      .from("inbound_emails")
      .select("id, from_addr, subject, body_text, attachments")
      .eq("created_record_id", data.orderId)
      .eq("created_record_type", "order")
      .maybeSingle();

    const attachments = Array.isArray(inbound?.attachments) ? inbound!.attachments : [];
    const email_content = inbound
      ? `From: ${inbound.from_addr}\nSubject: ${inbound.subject ?? ""}\n\n${inbound.body_text ?? ""}`
      : (order.raw_input ?? "");

    const url = `${process.env.SUPABASE_URL}/functions/v1/parse-po`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email_content, attachments }),
    });
    if (!r.ok) throw new Error(`parse-po ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const po = await r.json();
    if (po?.error) throw new Error(po.error);

    const lineItems = Array.isArray(po.line_items) ? po.line_items : [];
    const flags = Array.isArray(po.flags) ? po.flags : [];
    await supabaseAdmin.from("orders").update({
      line_items: lineItems,
      ai_confidence: typeof po.confidence === "number" ? po.confidence : undefined,
      ai_flags: flags,
      ...(po.customer_name ? { customer_name: po.customer_name } : {}),
      ...(po.po_number ? { po_number: po.po_number } : {}),
      ...(po.ship_to ? { ship_to: po.ship_to } : {}),
    }).eq("id", data.orderId);

    return { ok: true, line_count: lineItems.length, flags: flags.length };
  });
