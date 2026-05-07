import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Resend Inbound webhook receiver.
// Resend sends an `email.received` event with { data: { email_id, from, to, subject } }.
// The full email body is NOT in the webhook payload — fetch it from
// https://api.resend.com/emails/receiving/{email_id} using RESEND_API_KEY.

const TOLERANCE_MS = 5 * 60 * 1000;

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

  for (const part of sigHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

function parseAddr(field: any): { email: string; name: string | null } {
  if (!field) return { email: "unknown@unknown", name: null };
  if (typeof field === "object") {
    return { email: field.email ?? "unknown@unknown", name: field.name ?? null };
  }
  const s = String(field);
  const m = s.match(/^\s*(.*?)\s*<(.+?)>\s*$/);
  if (m) return { email: m[2], name: m[1] || null };
  return { email: s.trim(), name: null };
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

        // Only process inbound. Log other events for visibility.
        if (payload?.type && payload.type !== "email.received" && payload.type !== "inbound.email") {
          await supabaseAdmin.from("inbound_emails").insert({
            from_addr: "resend@webhook",
            subject: `[ignored event: ${payload.type}]`,
            headers: {},
            attachments: [],
            raw_payload: payload,
            status: "dismissed",
            classification: "unknown",
            error: `Ignored event type: ${payload.type}`,
            processed_at: new Date().toISOString(),
          });
          return Response.json({ ok: true, ignored: payload.type });
        }

        const d = payload?.data ?? {};
        const emailId: string | undefined = d.email_id ?? d.id;
        const fromMeta = parseAddr(d.from);
        const toMeta = Array.isArray(d.to) ? d.to[0] : d.to;
        const toAddr = parseAddr(toMeta).email;

        // Fetch full email content from Resend.
        const resendKey = process.env.RESEND_API_KEY;
        let body_text: string | null = null;
        let body_html: string | null = null;
        let headers: Record<string, any> = {};
        let attachments: any[] = [];
        let message_id: string | null = null;
        let fetchedSubject: string | null = null;
        let fetchError: string | null = null;
        let fullEmail: any = null;

        if (emailId && resendKey) {
          try {
            const r = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
              headers: { Authorization: `Bearer ${resendKey}` },
            });
            if (!r.ok) {
              fetchError = `Resend GET ${r.status}: ${(await r.text()).slice(0, 300)}`;
            } else {
              fullEmail = await r.json();
              body_text = fullEmail.text ?? null;
              body_html = fullEmail.html ?? null;
              if (!body_text && body_html) body_text = htmlToText(body_html);
              fetchedSubject = fullEmail.subject ?? null;
              message_id = fullEmail.message_id ?? fullEmail.headers?.["message-id"] ?? null;
              if (Array.isArray(fullEmail.headers)) {
                for (const h of fullEmail.headers) if (h?.name) headers[h.name] = h.value;
              } else if (fullEmail.headers && typeof fullEmail.headers === "object") {
                headers = fullEmail.headers;
              }
              attachments = Array.isArray(fullEmail.attachments) ? fullEmail.attachments : [];
            }
          } catch (e: any) {
            fetchError = String(e?.message ?? e);
          }
        } else if (!resendKey) {
          fetchError = "RESEND_API_KEY not configured";
        } else if (!emailId) {
          fetchError = "No email_id in webhook payload";
        }

        const subject = fetchedSubject ?? d.subject ?? null;

        const { data: row, error } = await supabaseAdmin
          .from("inbound_emails")
          .insert({
            message_id,
            from_addr: fromMeta.email,
            from_name: fromMeta.name,
            to_addr: toAddr,
            subject,
            body_text,
            body_html,
            headers,
            attachments,
            raw_payload: { webhook: payload, fetched: fullEmail },
            status: fetchError ? "error" : "received",
            error: fetchError,
          })
          .select("id")
          .single();
        if (error || !row) {
          console.error("inbound insert failed", error);
          return new Response("insert failed", { status: 500 });
        }

        if (fetchError) return Response.json({ ok: false, id: row.id, error: fetchError });

        const n = {
          from_addr: fromMeta.email,
          from_name: fromMeta.name,
          to_addr: toAddr,
          subject,
          body_text,
        };

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
      const { data: ord } = await supabaseAdmin
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
        const { data: ar } = await supabaseAdmin
          .from("ar_aging")
          .select("id")
          .eq("invoice_number", ext.invoice_number)
          .maybeSingle();
        arId = ar?.id ?? null;
        if (arId) {
          await supabaseAdmin.from("collection_emails").insert({
            ar_aging_id: arId,
            content: `Inbound reply from ${n.from_addr}\nSubject: ${n.subject ?? ""}\n\n${n.body_text ?? ""}`,
            status: "received",
            automated: false,
          });
          await supabaseAdmin
            .from("ar_aging")
            .update({ last_contacted_at: new Date().toISOString(), collection_status: "customer_replied" })
            .eq("id", arId);
        }
      }
      update.status = arId ? "routed" : "needs_review";
      if (arId) { update.created_record_type = "collection_email"; update.created_record_id = arId; }
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
      update.status = load ? "routed" : "needs_review";
      if (load) { update.created_record_type = "fleet_load"; update.created_record_id = load.id; }
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
    metadata: { confidence: update.confidence, created: update.created_record_type ?? null },
  });
}
