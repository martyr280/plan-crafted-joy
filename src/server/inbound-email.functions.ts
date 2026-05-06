import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

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
      .select("id, from_addr, from_name, subject, classification, confidence, status, ai_summary, created_record_type, created_record_id, received_at, processed_at, error")
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
  });
