import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Row = {
  id: string;
  from_addr: string;
  from_name: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  attachments: any;
};

async function callEdge(name: string, body: any): Promise<any> {
  const url = `${process.env.SUPABASE_URL}/functions/v1/${name}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`${name} ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

export async function classifyAndRouteInbound(id: string): Promise<{ status: string; classification: string }> {
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("inbound_emails")
    .select("id, from_addr, from_name, to_addr, subject, body_text, attachments")
    .eq("id", id)
    .single();
  if (loadErr || !row) throw new Error(loadErr?.message ?? "Inbound row not found");
  const r = row as Row;

  const update: any = {
    processed_at: new Date().toISOString(),
    error: null,
  };

  try {
    // 1. Classify
    const c = await callEdge("classify-inbound-email", {
      from_addr: r.from_addr,
      subject: r.subject,
      body_text: r.body_text,
    });
    const classification: string = c.classification ?? "unknown";
    const conf: number = Number(c.confidence ?? 0);
    let extracted: any = c.extracted ?? {};
    let flags: any[] = Array.isArray(c.flags) ? c.flags : [];
    let summary: string | null = c.summary ?? null;

    update.classification = classification;
    update.confidence = conf;
    update.ai_summary = summary;
    update.ai_extracted = extracted;
    update.ai_flags = flags;

    // 2. For purchase orders, run parse-po (PDFs + price verification) for richer extraction.
    if (classification === "purchase_order") {
      const attachments = Array.isArray(r.attachments) ? r.attachments : [];
      try {
        const po = await callEdge("parse-po", {
          email_content: `From: ${r.from_addr}\nSubject: ${r.subject ?? ""}\n\n${r.body_text ?? ""}`,
          attachments,
        });
        // Merge: prefer parse-po line items / fields when present.
        if (po && !po.error) {
          extracted = {
            ...extracted,
            ...(po.customer_name ? { customer_name: po.customer_name } : {}),
            ...(po.customer_id ? { customer_id: po.customer_id } : {}),
            ...(po.po_number ? { po_number: po.po_number } : {}),
            ...(po.ship_to ? { ship_to: po.ship_to } : {}),
            ...(Array.isArray(po.line_items) ? { line_items: po.line_items } : {}),
          };
          if (typeof po.confidence === "number") update.confidence = po.confidence;
          if (Array.isArray(po.flags)) flags = [...flags, ...po.flags];
          update.ai_extracted = extracted;
          update.ai_flags = flags;
        }
      } catch (e: any) {
        flags.push({ field: "parse-po", issue: e?.message ?? "parse-po failed", suggestion: "review manually" });
        update.ai_flags = flags;
      }
    }

    // 3. Route
    const lowConf = (update.confidence ?? 0) < 0.75;
    if (lowConf || classification === "unknown") {
      update.status = "needs_review";
    } else if (classification === "purchase_order") {
      const { data: ord } = await supabaseAdmin
        .from("orders")
        .insert({
          customer_name: extracted.customer_name ?? r.from_name ?? r.from_addr,
          customer_id: extracted.customer_id ?? null,
          po_number: extracted.po_number ?? null,
          ship_to: extracted.ship_to ?? null,
          source: "email_inbound",
          raw_input: `From: ${r.from_addr}\nSubject: ${r.subject ?? ""}\n\n${r.body_text ?? ""}`,
          status: "pending_review",
          line_items: Array.isArray(extracted.line_items) ? extracted.line_items : [],
          ai_confidence: update.confidence,
          ai_flags: flags,
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "order";
      update.created_record_id = ord?.id ?? null;
    } else if (classification === "ar_reply") {
      let arId: string | null = null;
      if (extracted.invoice_number) {
        const { data: ar } = await supabaseAdmin
          .from("ar_aging")
          .select("id")
          .eq("invoice_number", extracted.invoice_number)
          .maybeSingle();
        arId = ar?.id ?? null;
        if (arId) {
          await supabaseAdmin.from("collection_emails").insert({
            ar_aging_id: arId,
            content: `Inbound reply from ${r.from_addr}\nSubject: ${r.subject ?? ""}\n\n${r.body_text ?? ""}`,
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
    } else if (classification === "damage_report") {
      const { data: dmg } = await supabaseAdmin
        .from("damage_reports")
        .insert({
          p21_order_id: extracted.p21_order_id ?? null,
          route_code: extracted.route_code ?? null,
          stage: "delivery",
          severity: extracted.damage_severity ?? "minor",
          damage_type: extracted.damage_description ?? null,
          status: "open",
          photos: [],
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "damage_report";
      update.created_record_id = dmg?.id ?? null;
    } else if (classification === "logistics_update" && extracted.route_code) {
      const { data: load } = await supabaseAdmin
        .from("fleet_loads")
        .select("id")
        .eq("route_code", extracted.route_code)
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
    message: `Inbound email from ${r.from_addr} → ${update.classification ?? "?"} (${update.status})`,
    metadata: { confidence: update.confidence ?? null, created: update.created_record_type ?? null },
  });

  return { status: update.status, classification: update.classification ?? "unknown" };
}
