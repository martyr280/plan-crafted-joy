// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const INTERNAL_DOMAIN = "ndiof.com";

// Cheap rule-based pre-filter. Returns a classification when it matches, otherwise null
// so we fall through to the LLM call. Skipping the LLM here cuts cost on the ~30% of
// noise traffic (internal chatter, auto-replies, marketing).
function preClassify(from_addr: string, subject: string, body_text: string, headers: Record<string, any> = {}, to_addr?: string | null) {
  const from = (from_addr ?? "").toLowerCase();
  const to = (to_addr ?? "").toLowerCase();
  const subj = (subject ?? "").toLowerCase();
  const body = (body_text ?? "").toLowerCase();

  // Marketing / newsletter: List-Unsubscribe header is a strong signal.
  const headerKeys = Object.keys(headers ?? {}).map((k) => k.toLowerCase());
  if (headerKeys.includes("list-unsubscribe") || headerKeys.includes("list-id")) {
    return {
      classification: "marketing",
      confidence: 0.95,
      summary: "Marketing / newsletter (List-Unsubscribe header present)",
      extracted: {},
      flags: [],
      auto_dismiss: true,
    };
  }

  // OOO / auto-reply
  if (/automatic reply|out of office|auto-reply|autoreply|i am (out|away)|on vacation|on holiday/.test(subj) ||
      /automatic reply|out of office|i am out of the office|i'm out of the office/.test(body.slice(0, 500))) {
    return {
      classification: "auto_reply",
      confidence: 0.95,
      summary: "Out-of-office / auto-reply",
      extracted: {},
      flags: [],
      auto_dismiss: true,
    };
  }

  // Internal chatter: from @ndiof.com → @ndiof.com (no external recipient context here, so we check from only).
  if (from.endsWith(`@${INTERNAL_DOMAIN}`) && (!to || to.endsWith(`@${INTERNAL_DOMAIN}`) || to.endsWith(`@ndi.apexblueprint.ai`))) {
    return {
      classification: "internal",
      confidence: 0.9,
      summary: "Internal email between NDI employees",
      extracted: {},
      flags: [],
      auto_dismiss: true,
      is_internal: true,
    };
  }

  return null;
}

// Extract referenced order id (P21 SO#, Acknowledgement#, or invoice). Cheap regex over subject+body.
function extractReferencedOrderId(subject: string, body_text: string): string | null {
  const hay = `${subject ?? ""}\n${body_text ?? ""}`;
  const patterns = [
    /acknowledgement#?\s*(\d{6,8})/i,
    /\bSO#?\s*(\d{6,8})/i,
    /sales order#?\s*(\d{6,8})/i,
    /order#?\s*(\d{7,8})/i,
  ];
  for (const re of patterns) {
    const m = hay.match(re);
    if (m) return m[1];
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { from_addr, subject, body_text, headers, to_addr } = await req.json();

    // Cheap pre-filter first — skip LLM if we already know what this is.
    const pre = preClassify(from_addr ?? "", subject ?? "", body_text ?? "", headers ?? {}, to_addr ?? null);
    if (pre) {
      pre.referenced_order_id = extractReferencedOrderId(subject ?? "", body_text ?? "");
      return new Response(JSON.stringify(pre), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const tools = [{
      type: "function",
      function: {
        name: "classify_email",
        description: "Classify a forwarded email and extract relevant fields for routing.",
        parameters: {
          type: "object",
          properties: {
            classification: {
              type: "string",
              enum: [
                "purchase_order",
                "order_change",
                "quote_request",
                "return_request",
                "tracking_request",
                "ar_reply",
                "damage_report",
                "logistics_update",
                "auto_reply",
                "marketing",
                "internal",
                "unknown",
              ],
              description: "Best route for this email.",
            },
            confidence: { type: "number", description: "0..1" },
            summary: { type: "string", description: "One-sentence summary." },
            extracted: {
              type: "object",
              description: "Fields extracted relevant to the chosen classification.",
              properties: {
                customer_name: { type: "string" },
                customer_id: { type: "string" },
                po_number: { type: "string" },
                invoice_number: { type: "string" },
                p21_order_id: { type: "string", description: "P21 sales order number or acknowledgement number referenced in this email" },
                route_code: { type: "string" },
                damage_severity: { type: "string", enum: ["minor", "moderate", "severe"] },
                damage_description: { type: "string" },
                change_type: {
                  type: "string",
                  enum: ["add_line", "remove_line", "cancel", "ship_complete", "ship_partial", "address_change", "remove_accessory", "add_accessory", "qty_change", "other"],
                  description: "When classification is order_change, the type of change requested.",
                },
                change_details: { type: "string", description: "Plain-English description of the requested change." },
                line_items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      sku: { type: "string" },
                      description: { type: "string" },
                      qty: { type: "number" },
                      unit_price: { type: "number" },
                    },
                  },
                },
                notes: { type: "string" },
              },
            },
            flags: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  issue: { type: "string" },
                  suggestion: { type: "string" },
                },
                required: ["field", "issue", "suggestion"],
              },
            },
          },
          required: ["classification", "confidence", "summary", "extracted", "flags"],
        },
      },
    }];

    const system = `You triage forwarded emails for NDI, a commercial furniture distributor.
Choose ONE classification:
- purchase_order: NEW order with line items / PO number (not a change to an existing order)
- order_change: modification to an EXISTING order (cancel, add/remove line, change ship method, change address, remove liftgate, ship complete vs partial). The subject usually references an Acknowledgement# or SO#. Extract change_type and change_details.
- quote_request: customer is asking for pricing or a price match BEFORE placing an order ("please quote", "match price", "special bid")
- return_request: customer wants to return an item or get an RMA, wrong item shipped, etc.
- tracking_request: customer is asking where their order is, requesting a POD, tracking number, or delivery ETA
- ar_reply: customer replying about an unpaid invoice (mentions invoice #, payment, dispute)
- damage_report: photos / report of damaged goods at delivery or install
- logistics_update: internal driver/route/load updates, delivery confirmations, transfer notes
- auto_reply: out-of-office / vacation autoresponder
- marketing: vendor newsletter, promotional email, event invite
- internal: NDI employee chatter that doesn't fit another category
- unknown: doesn't clearly fit
Be conservative — pick "unknown" with low confidence rather than guess.
ALWAYS extract p21_order_id from the subject if you see "Acknowledgement#", "SO#", "Order#", or a 7-8 digit number that looks like an order.
Flag missing or suspicious fields. Return via classify_email tool only.`;

    const userMsg = `From: ${from_addr ?? "unknown"}\nTo: ${to_addr ?? "unknown"}\nSubject: ${subject ?? ""}\n\n${body_text ?? ""}`;

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userMsg },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "classify_email" } },
      }),
    });

    if (r.status === 429) return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
    if (r.status === 402) return new Response(JSON.stringify({ error: "AI credits exhausted" }), { status: 402, headers: { ...cors, "Content-Type": "application/json" } });
    if (!r.ok) {
      const txt = await r.text();
      console.error("AI gateway error", r.status, txt);
      return new Response(JSON.stringify({ error: "AI classify failed" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const j = await r.json();
    const call = j.choices?.[0]?.message?.tool_calls?.[0];
    const parsed = call ? JSON.parse(call.function.arguments) : {
      classification: "unknown", confidence: 0.2, summary: "Could not parse", extracted: {}, flags: [{ field: "all", issue: "no parse", suggestion: "manual review" }],
    };

    // Always attempt regex extraction in case the LLM missed it.
    const refId = extractReferencedOrderId(subject ?? "", body_text ?? "") ?? parsed?.extracted?.p21_order_id ?? null;
    parsed.referenced_order_id = refId;
    if (parsed?.extracted) parsed.extracted.p21_order_id = refId ?? parsed.extracted.p21_order_id ?? null;

    // Mark categories that should auto-dismiss.
    if (["auto_reply", "marketing", "internal"].includes(parsed.classification)) {
      parsed.auto_dismiss = true;
      if (parsed.classification === "internal") parsed.is_internal = true;
    }

    return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
