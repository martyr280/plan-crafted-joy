import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Provider-agnostic inbound email webhook.
// Accepts the common shapes from SendGrid Inbound Parse, Postmark, and CloudMailin.
// Auth: a shared bearer token in `Authorization: Bearer <token>` matching INBOUND_EMAIL_TOKEN.
// Configure your provider to POST forwarded emails to:
//   https://<your-app>/api/public/inbound-email
// with the bearer header set.

function pickString(...vals: any[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalize(payload: any) {
  // SendGrid: from, to, subject, text, html, headers, attachments (multipart)
  // Postmark: From, FromName, To, Subject, TextBody, HtmlBody, Headers[], Attachments[], MessageID
  // CloudMailin: envelope.from, envelope.to, headers.From, headers.Subject, plain, html, attachments[]
  const from_addr =
    pickString(
      payload?.From,
      payload?.from,
      payload?.envelope?.from,
      payload?.headers?.From,
    ) ?? "unknown@unknown";
  const from_name = pickString(payload?.FromName, payload?.from_name);
  const to_addr = pickString(payload?.To, payload?.to, payload?.envelope?.to, payload?.headers?.To);
  const subject = pickString(payload?.Subject, payload?.subject, payload?.headers?.Subject);
  const body_text = pickString(payload?.TextBody, payload?.text, payload?.plain, payload?.["body-plain"]);
  const body_html = pickString(payload?.HtmlBody, payload?.html, payload?.["body-html"]);
  const message_id = pickString(payload?.MessageID, payload?.["Message-Id"], payload?.headers?.["Message-ID"]);
  const headers = payload?.Headers ?? payload?.headers ?? {};
  const attachments = Array.isArray(payload?.Attachments)
    ? payload.Attachments
    : Array.isArray(payload?.attachments)
    ? payload.attachments
    : [];
  return { from_addr, from_name, to_addr, subject, body_text, body_html, message_id, headers, attachments };
}

export const Route = createFileRoute("/api/public/inbound-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = process.env.INBOUND_EMAIL_TOKEN;
        if (!token) return new Response("not configured", { status: 503 });
        const auth = request.headers.get("authorization") ?? "";
        if (auth !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });

        let payload: any;
        const ctype = request.headers.get("content-type") ?? "";
        try {
          if (ctype.includes("application/json")) {
            payload = await request.json();
          } else if (ctype.includes("multipart/form-data") || ctype.includes("application/x-www-form-urlencoded")) {
            const fd = await request.formData();
            payload = {};
            for (const [k, v] of fd.entries()) payload[k] = typeof v === "string" ? v : { filename: (v as File).name, size: (v as File).size };
          } else {
            payload = JSON.parse(await request.text());
          }
        } catch {
          return new Response("bad payload", { status: 400 });
        }

        const n = normalize(payload);

        const { data: row, error } = await supabaseAdmin
          .from("inbound_emails")
          .insert({
            message_id: n.message_id,
            from_addr: n.from_addr,
            from_name: n.from_name,
            to_addr: n.to_addr,
            subject: n.subject,
            body_text: n.body_text,
            body_html: n.body_html,
            headers: n.headers,
            attachments: n.attachments,
            raw_payload: payload,
            status: "received",
          })
          .select("id")
          .single();
        if (error || !row) {
          console.error("inbound insert failed", error);
          return new Response("insert failed", { status: 500 });
        }

        // Fire-and-forget classification + routing (don't block the provider).
        const supaUrl = process.env.SUPABASE_URL;
        const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supaUrl && supaKey) {
          fetch(`${supaUrl}/functions/v1/classify-inbound-email`, {
            method: "POST",
            headers: { Authorization: `Bearer ${supaKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from_addr: n.from_addr, subject: n.subject, body_text: n.body_text }),
          })
            .then(async (r) => {
              if (!r.ok) throw new Error(`classify ${r.status}`);
              const c = await r.json();
              await routeEmail(row.id, n, c);
            })
            .catch(async (e) => {
              await supabaseAdmin
                .from("inbound_emails")
                .update({ status: "error", error: String(e?.message ?? e) })
                .eq("id", row.id);
            });
        }

        return Response.json({ ok: true, id: row.id });
      },
    },
  },
});

async function routeEmail(id: string, n: ReturnType<typeof normalize>, c: any) {
  const update: any = {
    classification: c.classification ?? "unknown",
    confidence: c.confidence ?? null,
    ai_summary: c.summary ?? null,
    ai_extracted: c.extracted ?? {},
    ai_flags: c.flags ?? [],
    processed_at: new Date().toISOString(),
  };

  const lowConfidence = (c.confidence ?? 0) < 0.7;
  const ext = c.extracted ?? {};

  try {
    if (lowConfidence || c.classification === "unknown") {
      update.status = "needs_review";
    } else if (c.classification === "purchase_order") {
      const { data: ord } = await supabaseAdmin
        .from("orders")
        .insert({
          customer_name: ext.customer_name ?? n.from_name ?? n.from_addr,
          customer_id: ext.customer_id ?? null,
          po_number: ext.po_number ?? null,
          source: "email_forward",
          raw_input: `From: ${n.from_addr}\nSubject: ${n.subject ?? ""}\n\n${n.body_text ?? ""}`,
          status: "pending_review",
          line_items: Array.isArray(ext.line_items) ? ext.line_items : [],
          ai_confidence: c.confidence ?? null,
          ai_flags: c.flags ?? [],
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "order";
      update.created_record_id = ord?.id ?? null;
    } else if (c.classification === "ar_reply" && ext.invoice_number) {
      const { data: ar } = await supabaseAdmin
        .from("ar_aging")
        .select("id")
        .eq("invoice_number", ext.invoice_number)
        .maybeSingle();
      if (ar) {
        await supabaseAdmin.from("collection_emails").insert({
          ar_aging_id: ar.id,
          content: `Inbound reply from ${n.from_addr}\nSubject: ${n.subject ?? ""}\n\n${n.body_text ?? ""}`,
          status: "received",
          automated: false,
        });
        await supabaseAdmin
          .from("ar_aging")
          .update({ last_contacted_at: new Date().toISOString(), collection_status: "customer_replied" })
          .eq("id", ar.id);
        update.status = "routed";
        update.created_record_type = "collection_email";
        update.created_record_id = ar.id;
      } else {
        update.status = "needs_review";
      }
    } else if (c.classification === "damage_report") {
      const { data: dmg } = await supabaseAdmin
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
    } else if (c.classification === "logistics_update" && ext.route_code) {
      const { data: load } = await supabaseAdmin
        .from("fleet_loads")
        .select("id")
        .eq("route_code", ext.route_code)
        .maybeSingle();
      if (load) {
        update.status = "routed";
        update.created_record_type = "fleet_load";
        update.created_record_id = load.id;
      } else {
        update.status = "needs_review";
      }
    } else {
      update.status = "needs_review";
    }
  } catch (e: any) {
    update.status = "error";
    update.error = String(e?.message ?? e);
  }

  await supabaseAdmin.from("inbound_emails").update(update).eq("id", id);

  await supabaseAdmin.from("activity_events").insert({
    event_type: "inbound_email.processed",
    entity_type: "inbound_email",
    entity_id: id,
    actor_name: "system",
    message: `Inbound email from ${n.from_addr} → ${update.classification} (${update.status})`,
    metadata: { confidence: update.confidence, created: update.created_record_type },
  });
}
