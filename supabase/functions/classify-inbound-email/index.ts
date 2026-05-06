// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { from_addr, subject, body_text } = await req.json();
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
              enum: ["purchase_order", "ar_reply", "damage_report", "logistics_update", "unknown"],
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
                p21_order_id: { type: "string" },
                route_code: { type: "string" },
                damage_severity: { type: "string", enum: ["minor", "moderate", "severe"] },
                damage_description: { type: "string" },
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
- purchase_order: customer is placing an order (line items, PO number, ship-to)
- ar_reply: customer replying about an unpaid invoice (mentions invoice #, payment, dispute)
- damage_report: photos / report of damaged goods at delivery or install
- logistics_update: driver/route/load updates, delivery confirmations
- unknown: doesn't clearly fit
Be conservative — pick "unknown" with low confidence rather than guess.
Flag missing or suspicious fields. Return via classify_email tool only.`;

    const userMsg = `From: ${from_addr ?? "unknown"}\nSubject: ${subject ?? ""}\n\n${body_text ?? ""}`;

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
    return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
