import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

export const listWebhookDeliveries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ limit: z.number().int().min(1).max(200).default(50) }).parse)
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("inbound_emails")
      .select("id, message_id, from_addr, to_addr, subject, status, classification, confidence, error, headers, attachments, raw_payload, received_at, processed_at")
      .order("received_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });