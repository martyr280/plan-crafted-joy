import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Resend Inbound webhook receiver.
// Configure in Resend dashboard → Webhooks → add endpoint:
//   https://<your-app>/api/public/inbound-email
// subscribed to event "email.received". Resend gives you a signing secret
// starting with `whsec_` — store it as RESEND_WEBHOOK_SECRET.

const TOLERANCE_MS = 5 * 60 * 1000;

// Svix-style signature verification (Resend uses this scheme).
function verifySvix(body: string, headers: Headers, secret: string): boolean {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const sigHeader = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !sigHeader) return false;

  const ts = Number(timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TOLERANCE_MS) return false;

  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");

  const signed = `${id}.${timestamp}.${body}`;
  const expected = createHmac("sha256", secretBytes).update(signed).digest("base64");

  // Header is space-delimited "v1,<sig> v1,<sig2>"
  for (const part of sigHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

function pickString(...vals: any[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function normalize(payload: any) {
  // Resend inbound: { type: "email.received", data: { from, to, subject, text, html, headers, attachments } }
  const d = payload?.data ?? payload;
  const from_addr =
    pickString(
      typeof d?.from === "string" ? d.from : d?.from?.email,
      d?.From,
    ) ?? "unknown@unknown";
  const from_name = pickString(typeof d?.from === "object" ? d.from?.name : null, d?.FromName);
  const to_addr = pickString(
    Array.isArray(d?.to) ? d.to[0] : d?.to,
    d?.To,
  );
  const subject = pickString(d?.subject, d?.Subject);
  const body_text = pickString(d?.text, d?.TextBody, d?.plain);
  const body_html = pickString(d?.html, d?.HtmlBody);
  const message_id = pickString(d?.message_id, d?.MessageID, d?.headers?.["message-id"]);
  const headers = d?.headers ?? {};
  const attachments = Array.isArray(d?.attachments) ? d.attachments : [];
  return { from_addr, from_name, to_addr, subject, body_text, body_html, message_id, headers, attachments };
}

export const Route = createFileRoute("/api/public/inbound-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.RESEND_WEBHOOK_SECRET;
        if (!secret) return new Response("not configured", { status: 503 });

        const bodyText = await request.text();
        if (!verifySvix(bodyText, request.headers, secret)) {
          return new Response("invalid signature", { status: 401 });
        }

        let payload: any;
        try { payload = JSON.parse(bodyText); } catch { return new Response("bad json", { status: 400 }); }

        // Only process inbound email events; ack others quietly.
        if (payload?.type && payload.type !== "email.received" && payload.type !== "inbound.email") {
          return Response.json({ ok: true, ignored: payload.type });
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

        // Fire-and-forget classification + routing.
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
