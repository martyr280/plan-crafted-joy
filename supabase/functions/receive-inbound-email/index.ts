// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-postmark-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const POSTMARK_SECRET = Deno.env.get("POSTMARK_INBOUND_SECRET");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });

  // Verify shared secret. Postmark can include it via header, query param, or
  // as part of the configured webhook URL (?secret=...). Accept any.
  if (POSTMARK_SECRET) {
    const url = new URL(req.url);
    const headerSecret = req.headers.get("x-postmark-secret");
    const querySecret = url.searchParams.get("secret");
    if (headerSecret !== POSTMARK_SECRET && querySecret !== POSTMARK_SECRET) {
      return new Response("invalid secret", { status: 401, headers: cors });
    }
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400, headers: cors });
  }

  // Map Postmark Inbound payload → our schema.
  const headersArr = Array.isArray(payload.Headers) ? payload.Headers : [];
  const headersObj: Record<string, string> = {};
  for (const h of headersArr) if (h?.Name) headersObj[h.Name] = h.Value;

  const from_addr = payload.FromFull?.Email ?? payload.From ?? "unknown@unknown";
  const from_name = payload.FromFull?.Name ?? payload.FromName ?? null;
  const to_addr =
    payload.ToFull?.[0]?.Email ??
    (typeof payload.To === "string" ? payload.To.split(",")[0]?.trim() : null);
  const subject = payload.Subject ?? null;
  const body_text = payload.TextBody ?? null;
  const body_html = payload.HtmlBody ?? null;
  const message_id = payload.MessageID ?? headersObj["Message-ID"] ?? null;
  const attachments = Array.isArray(payload.Attachments) ? payload.Attachments : [];

  const { data: row, error: insErr } = await admin
    .from("inbound_emails")
    .insert({
      message_id,
      from_addr,
      from_name,
      to_addr,
      subject,
      body_text,
      body_html,
      headers: headersObj,
      attachments,
      raw_payload: payload,
      status: "received",
    })
    .select("id")
    .single();

  if (insErr || !row) {
    console.error("inbound insert failed", insErr);
    return new Response("insert failed", { status: 500, headers: cors });
  }

  // Classify + route. Don't fail the webhook if downstream errors.
  try {
    const cRes = await fetch(`${SUPABASE_URL}/functions/v1/classify-inbound-email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from_addr, subject, body_text }),
    });
    if (!cRes.ok) throw new Error(`classify ${cRes.status}`);
    const c = await cRes.json();
    await routeEmail(row.id, { from_addr, from_name, to_addr, subject, body_text }, c);
  } catch (e: any) {
    await admin
      .from("inbound_emails")
      .update({ status: "error", error: String(e?.message ?? e), processed_at: new Date().toISOString() })
      .eq("id", row.id);
  }

  return new Response(JSON.stringify({ ok: true, id: row.id }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});

async function routeEmail(id: string, n: any, c: any) {
  const update: any = {
    classification: c.classification ?? "unknown",
    confidence: c.confidence ?? null,
    ai_summary: c.summary ?? null,
    ai_extracted: c.extracted ?? {},
    ai_flags: c.flags ?? [],
    processed_at: new Date().toISOString(),
  };
  const ext = c.extracted ?? {};
  const conf = c.confidence ?? 0;

  try {
    if (conf < 0.75 || c.classification === "unknown") {
      update.status = "needs_review";
    } else if (c.classification === "purchase_order") {
      const { data: ord } = await admin
        .from("orders")
        .insert({
          customer_name: ext.customer_name ?? n.from_name ?? n.from_addr,
          customer_id: ext.customer_id ?? null,
          po_number: ext.po_number ?? null,
          source: "email_inbound",
          raw_input: `From: ${n.from_addr}\nSubject: ${n.subject ?? ""}\n\n${n.body_text ?? ""}`,
          status: "pending_review",
          line_items: Array.isArray(ext.line_items) ? ext.line_items : [],
          ai_confidence: conf,
          ai_flags: c.flags ?? [],
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "order";
      update.created_record_id = ord?.id ?? null;
    } else if (c.classification === "ar_reply") {
      let arId: string | null = null;
      if (ext.invoice_number) {
        const { data: ar } = await admin
          .from("ar_aging")
          .select("id")
          .eq("invoice_number", ext.invoice_number)
          .maybeSingle();
        arId = ar?.id ?? null;
        if (arId) {
          await admin.from("collection_emails").insert({
            ar_aging_id: arId,
            content: `Inbound reply from ${n.from_addr}\nSubject: ${n.subject ?? ""}\n\n${n.body_text ?? ""}`,
            status: "received",
            automated: false,
          });
          await admin
            .from("ar_aging")
            .update({ last_contacted_at: new Date().toISOString(), collection_status: "customer_replied" })
            .eq("id", arId);
        }
      }
      await admin.from("activity_events").insert({
        event_type: "ar_reply",
        entity_type: arId ? "ar_aging" : "inbound_email",
        entity_id: arId ?? id,
        actor_name: n.from_addr,
        message: c.summary ?? `AR reply from ${n.from_addr}`,
        metadata: { invoice_number: ext.invoice_number ?? null, notes: ext.notes ?? null },
      });
      update.status = arId ? "routed" : "needs_review";
      if (arId) {
        update.created_record_type = "collection_email";
        update.created_record_id = arId;
      }
    } else if (c.classification === "damage_report") {
      const { data: dmg } = await admin
        .from("damage_reports")
        .insert({
          p21_order_id: ext.p21_order_id ?? null,
          route_code: ext.route_code ?? null,
          stage: "delivery",
          severity: ext.damage_severity ?? "minor",
          damage_type: ext.damage_description ?? null,
          status: "open",
          photos: [],
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "damage_report";
      update.created_record_id = dmg?.id ?? null;
    } else if (c.classification === "logistics_update") {
      let loadId: string | null = null;
      if (ext.route_code) {
        const { data: load } = await admin
          .from("fleet_loads")
          .select("id")
          .eq("route_code", ext.route_code)
          .maybeSingle();
        loadId = load?.id ?? null;
      }
      await admin.from("activity_events").insert({
        event_type: "logistics_update",
        entity_type: loadId ? "fleet_load" : "inbound_email",
        entity_id: loadId ?? id,
        actor_name: n.from_addr,
        message: c.summary ?? `Logistics update from ${n.from_addr}`,
        metadata: { route_code: ext.route_code ?? null, notes: ext.notes ?? null },
      });
      update.status = loadId ? "routed" : "needs_review";
      if (loadId) {
        update.created_record_type = "fleet_load";
        update.created_record_id = loadId;
      }
    } else {
      update.status = "needs_review";
    }
  } catch (e: any) {
    update.status = "error";
    update.error = String(e?.message ?? e);
  }

  await admin.from("inbound_emails").update(update).eq("id", id);

  await admin.from("activity_events").insert({
    event_type: "inbound_email.processed",
    entity_type: "inbound_email",
    entity_id: id,
    actor_name: "system",
    message: `Inbound email from ${n.from_addr} → ${update.classification} (${update.status})`,
    metadata: { confidence: update.confidence, created: update.created_record_type ?? null },
  });
}
