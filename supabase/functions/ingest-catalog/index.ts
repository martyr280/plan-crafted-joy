// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PAGES_PER_CHUNK = 8;

function normSku(s: string) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[.,;]+$/, "").trim();
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function extractChunk(apiKey: string, b64: string, startPage: number): Promise<any[]> {
  const tools = [{
    type: "function",
    function: {
      name: "extract_catalog_rows",
      description: "Extract every product/SKU row from the catalog page range.",
      parameters: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sku: { type: "string", description: "Part number / item code as printed" },
                description: { type: "string" },
                list_price: { type: "number" },
                mfg: { type: "string", description: "Section manufacturer header if visible" },
                page: { type: "integer", description: "Page number within this chunk (1-based)" },
              },
              required: ["sku"],
            },
          },
        },
        required: ["rows"],
      },
    },
  }];

  const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "You are reading an NDI commercial furniture catalog. Extract EVERY product row across all pages: part number / SKU, description, list price (if shown), and the section's manufacturer (if a header indicates one). Skip headers, footers, page numbers, marketing copy, and the table of contents. Be thorough — include every row even on dense price-list pages." },
        { role: "user", content: [
          { type: "text", text: `Extract all product rows from this PDF chunk. The first page here corresponds to original page ${startPage}.` },
          { type: "image_url", image_url: { url: `data:application/pdf;base64,${b64}` } },
        ] },
      ],
      tools,
      tool_choice: { type: "function", function: { name: "extract_catalog_rows" } },
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error("AI gateway", r.status, t.slice(0, 300));
    throw new Error(`AI ${r.status}`);
  }
  const j = await r.json();
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return [];
  try {
    const args = JSON.parse(call.function.arguments);
    const rows = Array.isArray(args.rows) ? args.rows : [];
    return rows.map((row: any) => ({
      ...row,
      page: Number.isFinite(row.page) ? startPage + Number(row.page) - 1 : startPage,
    }));
  } catch (e) {
    console.error("parse args failed", e);
    return [];
  }
}

async function ingest(catalogId: string) {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

  const { data: cat, error: catErr } = await supabase
    .from("catalogs").select("id, name, file_path").eq("id", catalogId).single();
  if (catErr || !cat) throw new Error(catErr?.message ?? "catalog not found");

  await supabase.from("catalogs").update({ parse_status: "parsing", parse_error: null }).eq("id", catalogId);
  // Clear any previous rows for a clean re-ingest
  await supabase.from("catalog_items").delete().eq("catalog_id", catalogId);

  // Download PDF from storage (signed URL works for private buckets too)
  const { data: signed, error: signErr } = await supabase.storage.from("catalogs").createSignedUrl(cat.file_path, 600);
  if (signErr || !signed?.signedUrl) throw new Error(signErr?.message ?? "could not sign url");
  const pdfResp = await fetch(signed.signedUrl);
  if (!pdfResp.ok) throw new Error(`download pdf ${pdfResp.status}`);
  const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer());
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const totalPages = src.getPageCount();

  await supabase.from("catalogs").update({ pages: totalPages }).eq("id", catalogId);

  let totalSkus = 0;
  const seenInCatalog = new Set<string>();

  for (let start = 0; start < totalPages; start += PAGES_PER_CHUNK) {
    const end = Math.min(start + PAGES_PER_CHUNK, totalPages);
    const sub = await PDFDocument.create();
    const pageIndices = Array.from({ length: end - start }, (_, i) => start + i);
    const copied = await sub.copyPages(src, pageIndices);
    copied.forEach((p) => sub.addPage(p));
    const subBytes = await sub.save();
    const b64 = bytesToBase64(subBytes);

    let rows: any[] = [];
    try {
      rows = await extractChunk(apiKey, b64, start + 1);
    } catch (e) {
      console.error(`chunk ${start}-${end} failed`, e);
      continue;
    }

    const inserts: any[] = [];
    for (const row of rows) {
      const sku = normSku(row.sku);
      if (!sku) continue;
      if (seenInCatalog.has(sku)) continue;
      seenInCatalog.add(sku);
      inserts.push({
        catalog_id: catalogId,
        sku,
        description: row.description ?? null,
        list_price: Number.isFinite(row.list_price) ? row.list_price : null,
        page: row.page ?? null,
        mfg: row.mfg ?? null,
        raw: typeof row === "object" ? JSON.stringify(row).slice(0, 500) : null,
      });
    }
    if (inserts.length) {
      const { error: insErr } = await supabase.from("catalog_items").insert(inserts);
      if (insErr) console.error("insert err", insErr);
      else totalSkus += inserts.length;
    }
    await supabase.from("catalogs").update({ sku_count: totalSkus }).eq("id", catalogId);
  }

  await supabase.from("catalogs").update({
    parse_status: "ready",
    parsed_at: new Date().toISOString(),
    sku_count: totalSkus,
  }).eq("id", catalogId);

  await supabase.from("activity_events").insert({
    event_type: "catalog.ingested",
    entity_type: "catalog",
    entity_id: catalogId,
    actor_name: "system",
    message: `Catalog "${cat.name}" parsed: ${totalSkus} SKUs across ${totalPages} pages`,
    metadata: { sku_count: totalSkus, pages: totalPages },
  });

  return { totalPages, totalSkus };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { catalog_id } = await req.json();
    if (!catalog_id) throw new Error("catalog_id required");

    // Run in background so caller doesn't time out on large catalogs.
    // @ts-ignore EdgeRuntime is provided in Supabase functions runtime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(ingest(catalog_id).catch(async (e) => {
        console.error("ingest failed", e);
        const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        await supabase.from("catalogs").update({ parse_status: "error", parse_error: String(e?.message ?? e) }).eq("id", catalog_id);
      }));
      return new Response(JSON.stringify({ status: "started" }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    const r = await ingest(catalog_id);
    return new Response(JSON.stringify({ status: "done", ...r }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
