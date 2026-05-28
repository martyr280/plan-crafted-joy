import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Row = {
  id: string;
  from_addr: string;
  from_name: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  attachments: any;
  headers: any;
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

// Resolve a referenced order id (P21 SO#) to a local orders row, if we have one.
async function findLocalOrderByP21Id(p21OrderId: string | null): Promise<string | null> {
  if (!p21OrderId) return null;
  const { data } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("p21_order_id", p21OrderId)
    .maybeSingle();
  return data?.id ?? null;
}

export async function classifyAndRouteInbound(id: string): Promise<{ status: string; classification: string }> {
  const { data: row, error: loadErr } = await supabaseAdmin
    .from("inbound_emails")
    .select("id, from_addr, from_name, to_addr, subject, body_text, attachments, headers")
    .eq("id", id)
    .single();
  if (loadErr || !row) throw new Error(loadErr?.message ?? "Inbound row not found");
  const r = row as Row;

  const update: any = {
    processed_at: new Date().toISOString(),
    error: null,
  };

  try {
    // 1. Classify (with pre-filter inside the edge function for cheap noise rejection)
    const c = await callEdge("classify-inbound-email", {
      from_addr: r.from_addr,
      to_addr: r.to_addr,
      subject: r.subject,
      body_text: r.body_text,
      headers: r.headers ?? {},
    });
    const classification: string = c.classification ?? "unknown";
    const conf: number = Number(c.confidence ?? 0);
    let extracted: any = c.extracted ?? {};
    let flags: any[] = Array.isArray(c.flags) ? c.flags : [];
    const summary: string | null = c.summary ?? null;
    const referencedOrderId: string | null = c.referenced_order_id ?? extracted.p21_order_id ?? null;
    const isInternal: boolean = !!c.is_internal;

    update.classification = classification;
    update.confidence = conf;
    update.ai_summary = summary;
    update.ai_extracted = extracted;
    update.ai_flags = flags;
    update.referenced_order_id = referencedOrderId;
    update.change_type = extracted?.change_type ?? null;
    update.is_internal = isInternal;

    // 2. Auto-dismiss noise categories without further routing.
    if (c.auto_dismiss || ["auto_reply", "marketing", "internal"].includes(classification)) {
      update.status = "dismissed";
      await persistAndLog(id, r, update);
      return { status: update.status, classification };
    }

    // 3. For purchase orders, run parse-po (PDFs + price verification) for richer extraction.
    if (classification === "purchase_order") {
      const attachments = Array.isArray(r.attachments) ? r.attachments : [];
      try {
        const po = await callEdge("parse-po", {
          email_content: `From: ${r.from_addr}\nSubject: ${r.subject ?? ""}\n\n${r.body_text ?? ""}`,
          attachments,
        });
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

    // 4. Route by classification
    const lowConf = (update.confidence ?? 0) < 0.7;
    const linkedOrderId = await findLocalOrderByP21Id(referencedOrderId);

    if (lowConf || classification === "unknown") {
      update.status = "needs_review";
    } else if (classification === "purchase_order") {
      const lineItems = Array.isArray(extracted.line_items) ? extracted.line_items : [];
      if (lineItems.length === 0) {
        flags.push({ field: "line_items", issue: "no line items extracted", suggestion: "re-run extraction or enter manually" });
        update.ai_flags = flags;
      }
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
          line_items: lineItems,
          ai_confidence: update.confidence,
          ai_flags: flags,
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "order";
      update.created_record_id = ord?.id ?? null;
    } else if (classification === "order_change") {
      const { data: ocr } = await supabaseAdmin
        .from("order_change_requests")
        .insert({
          order_id: linkedOrderId,
          p21_order_id: referencedOrderId,
          inbound_email_id: id,
          change_type: extracted.change_type ?? "other",
          payload: {
            details: extracted.change_details ?? null,
            from: r.from_addr,
            subject: r.subject,
            ...extracted,
          },
          status: "open",
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "order_change_request";
      update.created_record_id = ocr?.id ?? null;
    } else if (classification === "quote_request") {
      const { data: q } = await supabaseAdmin
        .from("quote_requests")
        .insert({
          inbound_email_id: id,
          customer_name: extracted.customer_name ?? r.from_name ?? r.from_addr,
          customer_id: extracted.customer_id ?? null,
          subject: r.subject,
          line_items: Array.isArray(extracted.line_items) ? extracted.line_items : [],
          notes: extracted.notes ?? null,
          status: "open",
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "quote_request";
      update.created_record_id = q?.id ?? null;
    } else if (classification === "return_request") {
      const { data: rma } = await supabaseAdmin
        .from("rma_requests")
        .insert({
          inbound_email_id: id,
          customer_name: extracted.customer_name ?? r.from_name ?? r.from_addr,
          customer_id: extracted.customer_id ?? null,
          original_invoice: extracted.invoice_number ?? null,
          original_order_id: referencedOrderId,
          items: Array.isArray(extracted.line_items) ? extracted.line_items : [],
          reason: extracted.notes ?? null,
          status: "open",
        })
        .select("id")
        .single();
      update.status = "routed";
      update.created_record_type = "rma_request";
      update.created_record_id = rma?.id ?? null;
    } else if (classification === "tracking_request") {
      // Surface as a change request of type "tracking" against the referenced order;
      // actual P21 lookup + reply drafting is out of scope for this pass.
      const { data: ocr } = await supabaseAdmin
        .from("order_change_requests")
        .insert({
          order_id: linkedOrderId,
          p21_order_id: referencedOrderId,
          inbound_email_id: id,
          change_type: "tracking",
          payload: {
            details: extracted.notes ?? "Customer requested tracking / POD",
            from: r.from_addr,
            subject: r.subject,
          },
          status: "open",
        })
        .select("id")
        .single();
      update.status = referencedOrderId ? "routed" : "needs_review";
      update.created_record_type = "order_change_request";
      update.created_record_id = ocr?.id ?? null;
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
          p21_order_id: referencedOrderId ?? extracted.p21_order_id ?? null,
          order_id: linkedOrderId,
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

    // 5. Thread the email body onto the referenced order's activity feed (any classification).
    if (linkedOrderId) {
      await supabaseAdmin.from("activity_events").insert({
        event_type: "order.inbound_email",
        entity_type: "order",
        entity_id: linkedOrderId,
        actor_name: r.from_name ?? r.from_addr,
        message: `${classification.replace(/_/g, " ")}: ${r.subject ?? "(no subject)"}`,
        metadata: {
          inbound_email_id: id,
          from: r.from_addr,
          classification,
          referenced_order_id: referencedOrderId,
        },
      });
    }
  } catch (e: any) {
    update.status = "error";
    update.error = String(e?.message ?? e);
  }

  await persistAndLog(id, r, update);
  return { status: update.status, classification: update.classification ?? "unknown" };
}

async function persistAndLog(id: string, r: Row, update: any) {
  await supabaseAdmin.from("inbound_emails").update(update).eq("id", id);
  await supabaseAdmin.from("activity_events").insert({
    event_type: "inbound_email.processed",
    entity_type: "inbound_email",
    entity_id: id,
    actor_name: "system",
    message: `Inbound email from ${r.from_addr} → ${update.classification ?? "?"} (${update.status})`,
    metadata: {
      confidence: update.confidence ?? null,
      created: update.created_record_type ?? null,
      referenced_order_id: update.referenced_order_id ?? null,
    },
  });
}
