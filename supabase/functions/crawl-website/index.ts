// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const FIRECRAWL = "https://api.firecrawl.dev/v2";
const ROOT = "https://www.ndiof.com";
const BATCH = 40;
const MAX_URLS = 6000;

function normSku(s: string) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[.,;]+$/, "").trim();
}

async function fcMap(apiKey: string): Promise<string[]> {
  const r = await fetch(`${FIRECRAWL}/map`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: ROOT, limit: MAX_URLS, includeSubdomains: false }),
  });
  if (!r.ok) throw new Error(`firecrawl /map ${r.status}: ${await r.text()}`);
  const j = await r.json();
  // v2 returns { success, links: [{url,...}] } or sometimes string array
  const links = j.links ?? j.data?.links ?? [];
  return links.map((l: any) => (typeof l === "string" ? l : l.url)).filter(Boolean);
}

async function fcBatchScrape(apiKey: string, urls: string[]): Promise<any[]> {
  // Use synchronous batch scrape with markdown only.
  const start = await fetch(`${FIRECRAWL}/batch/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      urls,
      formats: ["markdown"],
      onlyMainContent: true,
    }),
  });
  if (!start.ok) throw new Error(`firecrawl batch start ${start.status}: ${await start.text()}`);
  const startJson = await start.json();
  const id = startJson.id ?? startJson.jobId ?? startJson.data?.id;
  if (!id) throw new Error(`no batch id: ${JSON.stringify(startJson)}`);

  // Poll
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await fetch(`${FIRECRAWL}/batch/scrape/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!s.ok) continue;
    const sj = await s.json();
    const status = sj.status ?? sj.data?.status;
    if (status === "completed" || status === "succeeded") {
      let data = sj.data ?? [];
      // Pagination
      let next = sj.next;
      while (next) {
        const np = await fetch(next, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (!np.ok) break;
        const nj = await np.json();
        data = data.concat(nj.data ?? []);
        next = nj.next;
      }
      return data;
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`batch ${status}: ${JSON.stringify(sj).slice(0, 300)}`);
    }
  }
  throw new Error("batch poll timeout");
}

// Parse one scraped item-detail markdown blob.
// Pattern from ndiof.com listing/detail blocks:
//   ## [Name](https://www.ndiof.com/itemdetail/SKU)
//   SKU: [SKU](...)
//   Brand: <brand>
//   <description line>
//   In Stock / Out of Stock
function parseItemMarkdown(url: string, md: string): {
  sku?: string; name?: string; description?: string; brand?: string;
  image_url?: string; in_stock?: boolean; stock_text?: string;
} {
  const out: any = { detail_url: url };
  // SKU from URL or markdown
  const urlSku = url.match(/\/itemdetail\/([^/?#]+)/i)?.[1];
  if (urlSku) out.sku = decodeURIComponent(urlSku);
  const skuMatch = md.match(/SKU:\s*\[?([A-Z0-9._\-/]+)\]?/i);
  if (skuMatch) out.sku = skuMatch[1];

  // Name: first H2 or H1 link/text
  const h = md.match(/^##\s+\[?([^\]\n]+?)\]?(?:\(|$)/m);
  if (h) out.name = h[1].trim();

  // Brand
  const b = md.match(/Brand:\s*\n?\s*([^\n]+)/i);
  if (b) out.brand = b[1].trim();

  // First image
  const img = md.match(/!\[[^\]]*\]\((https?:[^)]+)\)/);
  if (img) out.image_url = img[1];

  // Stock
  if (/Out of Stock|Unavailable|Discontinued/i.test(md)) {
    out.in_stock = false;
    out.stock_text = (md.match(/(Out of Stock|Unavailable|Discontinued)[^\n]*/i)?.[0] || "").trim();
  } else if (/In Stock/i.test(md)) {
    out.in_stock = true;
    out.stock_text = (md.match(/In Stock[^\n]*/i)?.[0] || "").trim();
  }

  // Description: line right before "More Info" or right after Brand
  // Take the longest non-link line in the doc that isn't the name.
  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);
  let best = "";
  for (const l of lines) {
    if (l.startsWith("#") || l.startsWith("[") || l.startsWith("![") || /^SKU:|^Brand:|^Loading|^In Stock|^Out of/i.test(l)) continue;
    if (l.length > best.length && l.length < 240) best = l;
  }
  if (best) out.description = best;

  return out;
}

async function runCrawl(crawlId: string) {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY missing");

  // 1. Map
  const allLinks = await fcMap(apiKey);
  const itemUrls = Array.from(new Set(allLinks.filter((u) => /\/itemdetail\//i.test(u))));
  await supabase.from("website_crawls").update({ pages_crawled: 0, notes: `Discovered ${itemUrls.length} item URLs` }).eq("id", crawlId);

  if (itemUrls.length === 0) throw new Error("No item URLs discovered from map");

  // 2. Batch scrape in chunks
  let totalPages = 0;
  let totalSkus = 0;
  const seen = new Set<string>();

  for (let i = 0; i < itemUrls.length; i += BATCH) {
    const chunk = itemUrls.slice(i, i + BATCH);
    let results: any[] = [];
    try {
      results = await fcBatchScrape(apiKey, chunk);
    } catch (e) {
      console.error(`batch ${i} failed`, e);
      continue;
    }

    const rows: any[] = [];
    for (const r of results) {
      totalPages++;
      const md = r.markdown ?? r.data?.markdown ?? "";
      const sourceUrl = r.metadata?.sourceURL ?? r.metadata?.url ?? r.url ?? "";
      if (!md) continue;
      const parsed = parseItemMarkdown(sourceUrl, md);
      const sku = normSku(parsed.sku || "");
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      rows.push({
        sku,
        name: parsed.name ?? null,
        description: parsed.description ?? null,
        image_url: parsed.image_url ?? null,
        detail_url: sourceUrl || null,
        brand: parsed.brand ?? null,
        in_stock: parsed.in_stock ?? null,
        stock_text: parsed.stock_text ?? null,
        crawl_id: crawlId,
        crawled_at: new Date().toISOString(),
      });
    }
    if (rows.length) {
      const { error } = await supabase.from("website_items").upsert(rows, { onConflict: "sku" });
      if (error) console.error("upsert err", error);
      else totalSkus += rows.length;
    }
    await supabase.from("website_crawls").update({
      pages_crawled: totalPages,
      skus_found: totalSkus,
    }).eq("id", crawlId);
  }

  await supabase.from("website_crawls").update({
    status: "completed",
    completed_at: new Date().toISOString(),
    pages_crawled: totalPages,
    skus_found: totalSkus,
  }).eq("id", crawlId);

  await supabase.from("activity_events").insert({
    event_type: "website.crawled",
    entity_type: "website_crawl",
    entity_id: crawlId,
    actor_name: "system",
    message: `Website crawl completed: ${totalSkus} SKUs from ${totalPages} pages`,
    metadata: { sku_count: totalSkus, pages: totalPages },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const triggeredBy = body.user_id ?? null;

    const { data: crawl, error } = await supabase.from("website_crawls").insert({
      status: "running",
      triggered_by: triggeredBy,
    }).select("id").single();
    if (error || !crawl) throw error ?? new Error("could not create crawl row");

    // @ts-ignore
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(runCrawl(crawl.id).catch(async (e) => {
        console.error("crawl failed", e);
        await supabase.from("website_crawls").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: String(e?.message ?? e),
        }).eq("id", crawl.id);
      }));
      return new Response(JSON.stringify({ status: "started", crawl_id: crawl.id }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await runCrawl(crawl.id);
    return new Response(JSON.stringify({ status: "done", crawl_id: crawl.id }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
