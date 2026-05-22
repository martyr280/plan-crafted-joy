// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Attachment = { filename: string; content_type?: string; base64?: string; url?: string };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { email_content, attachments = [] } = await req.json() as { email_content: string; attachments?: Attachment[] };
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    // Build multimodal user content: email text + any PDF attachments (Gemini accepts PDFs as image_url base64 data URLs).
    const userContent: any[] = [{ type: "text", text: email_content || "(no email body provided)" }];

    const pdfs = (attachments || []).filter(
      (a) => (a.content_type && a.content_type.toLowerCase().includes("pdf")) || /\.pdf$/i.test(a.filename || "")
    );

    for (const att of pdfs) {
      let b64 = att.base64;
      if (!b64 && att.url) {
        try {
          const r = await fetch(att.url);
          const buf = new Uint8Array(await r.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          b64 = btoa(bin);
        } catch (e) {
          console.error("Failed to fetch attachment", att.filename, e);
          continue;
        }
      }
      if (!b64) continue;
      userContent.push({ type: "text", text: `\n--- Attached PDF: ${att.filename} ---` });
      userContent.push({ type: "image_url", image_url: { url: `data:application/pdf;base64,${b64}` } });
    }

    const tools = [{
      type: "function",
      function: {
        name: "extract_po",
        description: "Extract a structured purchase order from an email body and any attached PDFs.",
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
        model: pdfs.length ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "You extract purchase orders for NDI, a commercial furniture distributor. Read the email body AND any attached PDF purchase orders to assemble a single combined order. Be precise with SKUs, qty, and unit prices. Flag competitor SKUs, missing prices, or low confidence customer matches. Return only via the extract_po tool." },
          { role: "user", content: userContent },
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
    const parsed: any = call ? JSON.parse(call.function.arguments) : { customer_name: "Unknown", line_items: [], confidence: 0.3, flags: [{ field: "all", issue: "Could not parse", suggestion: "Manual entry required" }] };

    // ---- Price verification against price_list AND catalog_items ----
    const normSku = (s: any) => String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[.,;]+$/, "").trim();
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const rawSkus = (parsed.line_items || []).map((l: any) => String(l.sku || "").trim()).filter(Boolean);
      const normSkus = Array.from(new Set(rawSkus.map(normSku)));
      const allSkus = Array.from(new Set([...rawSkus, ...normSkus]));

      let priceMap: Record<string, any> = {};
      let catalogMap: Record<string, any> = {};
      let e2gMap: Record<string, any> = {};
      if (allSkus.length) {
        const { data: prices } = await supabase
          .from("price_list")
          .select("item, list_price, dealer_cost, er_cost, mfg, description")
          .in("item", allSkus)
          .limit(allSkus.length + 100);
        for (const p of prices || []) {
          priceMap[String(p.item)] = p;
          priceMap[normSku(p.item)] = p;
        }
        const { data: cat } = await supabase
          .from("catalog_items")
          .select("sku, description, list_price, mfg, page, catalog_id")
          .in("sku", normSkus)
          .limit(normSkus.length + 100);
        for (const c of cat || []) catalogMap[String(c.sku)] = c;

        const { data: e2g } = await supabase
          .from("e2g_inventory_snapshot")
          .select("item_id, item_desc, e2g_price, total")
          .in("item_id", allSkus)
          .limit(allSkus.length + 100);
        for (const e of e2g || []) {
          e2gMap[String(e.item_id)] = e;
          e2gMap[normSku(e.item_id)] = e;
        }
      }

      let unknownCount = 0;
      parsed.flags = parsed.flags || [];
      (parsed.line_items || []).forEach((li: any, i: number) => {
        const raw = String(li.sku || "").trim();
        const norm = normSku(raw);
        const price = priceMap[raw] || priceMap[norm];
        const cat = catalogMap[norm];
        const e2g = e2gMap[raw] || e2gMap[norm];

        if (price) {
          li.price_list_match = {
            list_price: price.list_price,
            dealer_cost: price.dealer_cost,
            er_cost: price.er_cost,
            mfg: price.mfg,
            description: price.description,
            source: "contract",
          };
          const list = Number(price.list_price);
          const unit = Number(li.unit_price);
          if (Number.isFinite(list) && Number.isFinite(unit) && Math.abs(list - unit) > 0.01) {
            parsed.flags.push({
              field: `line[${i}].unit_price`,
              issue: `PO price $${unit.toFixed(2)} differs from list $${list.toFixed(2)} for ${li.sku}`,
              suggestion: "Confirm contract pricing before submitting",
            });
          }
        } else if (cat) {
          li.price_list_match = {
            list_price: cat.list_price,
            description: cat.description,
            mfg: cat.mfg,
            page: cat.page,
            source: "catalog",
          };
          parsed.flags.push({
            field: `line[${i}].sku`,
            issue: `SKU ${li.sku} found in catalog (page ${cat.page ?? "?"}) but no contract price on file`,
            suggestion: "Confirm pricing with sales before submitting",
          });
        } else if (e2g) {
          li.price_list_match = {
            list_price: e2g.e2g_price,
            description: e2g.item_desc,
            source: "e2g",
            stock: e2g.total,
          };
          parsed.flags.push({
            field: `line[${i}].sku`,
            issue: `SKU ${li.sku} priced from E2G inventory upload (no contract price)`,
            suggestion: "Verify pricing before submitting",
          });
        } else {
          parsed.flags.push({
            field: `line[${i}].sku`,
            issue: `SKU ${li.sku} not found in price list, catalog, or E2G`,
            suggestion: "Verify part number — may be a competitor SKU",
          });
          unknownCount++;
        }
      });
      const total = (parsed.line_items || []).length || 1;
      if (unknownCount / total > 0.2) {
        parsed.confidence = Math.min(parsed.confidence ?? 0.5, 0.6);
      }
    } catch (e) {
      console.error("price verification failed", e);
    }

    return new Response(JSON.stringify({ parsed }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
