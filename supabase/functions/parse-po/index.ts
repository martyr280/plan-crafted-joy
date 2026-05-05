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
    const { email_content } = await req.json();
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const tools = [{
      type: "function",
      function: {
        name: "extract_po",
        description: "Extract a structured purchase order from an email body.",
        parameters: {
          type: "object",
          properties: {
            customer_name: { type: "string" },
            customer_id: { type: "string" },
            po_number: { type: "string" },
            ship_to: {
              type: "object",
              properties: { name: { type: "string" }, address: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" } },
            },
            line_items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  sku: { type: "string" },
                  description: { type: "string" },
                  qty: { type: "number" },
                  unit_price: { type: "number" },
                  line_total: { type: "number" },
                },
                required: ["sku", "description", "qty"],
              },
            },
            confidence: { type: "number", description: "0..1 overall confidence" },
            flags: {
              type: "array",
              items: {
                type: "object",
                properties: { field: { type: "string" }, issue: { type: "string" }, suggestion: { type: "string" } },
                required: ["field", "issue", "suggestion"],
              },
            },
          },
          required: ["customer_name", "line_items", "confidence", "flags"],
        },
      },
    }];

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "You extract purchase orders from emails for NDI, a commercial furniture distributor. Be precise. Flag any SKU that looks like a competitor part number, missing prices, or low confidence customer matches. Return via the extract_po tool only." },
          { role: "user", content: email_content },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "extract_po" } },
      }),
    });

    if (r.status === 429) return new Response(JSON.stringify({ error: "Rate limit exceeded, try again shortly." }), { status: 429, headers: { ...cors, "Content-Type": "application/json" } });
    if (r.status === 402) return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in Lovable workspace settings." }), { status: 402, headers: { ...cors, "Content-Type": "application/json" } });
    if (!r.ok) {
      const txt = await r.text();
      console.error("AI gateway error", r.status, txt);
      return new Response(JSON.stringify({ error: "AI parse failed" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const j = await r.json();
    const call = j.choices?.[0]?.message?.tool_calls?.[0];
    const parsed = call ? JSON.parse(call.function.arguments) : { customer_name: "Unknown", line_items: [], confidence: 0.3, flags: [{ field: "all", issue: "Could not parse", suggestion: "Manual entry required" }] };
    return new Response(JSON.stringify({ parsed }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
