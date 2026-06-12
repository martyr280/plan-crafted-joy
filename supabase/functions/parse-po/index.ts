// @ts-nocheck
import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Attachment = { filename: string; content_type?: string; base64?: string; url?: string };

// ---------- Pipeline helpers ----------
const FINISH_SUFFIXES = [
  // Compound first (longest-match wins)
  "VBLK","CBLK","SMBLK","MAGO",
  // Base finishes
  "BLK","SIL","NPG","MWN","ESP","MAH","CGY","AGO","DVO","APN","WHT","CH","OXB","BRU","GRY","LGY","BLU","GRN",
];

const COLOR_WORD_TO_SUFFIX: Array<[RegExp, string]> = [
  [/\bblack\b|\bblk\b/i, "BLK"],
  [/\bsilver\b|\bsil\b/i, "SIL"],
  [/\bnewport\s*gr[ae]y\b|\bnpg\b/i, "NPG"],
  [/\bmwn\b|\bmedium\s*walnut\b|\bwalnut\b/i, "MWN"],
  [/\bespresso\b|\besp\b/i, "ESP"],
  [/\bmahogany\b|\bmah\b/i, "MAH"],
  [/\bcharcoal\s*gr[ae]y\b|\bcgy\b/i, "CGY"],
  [/\baged\s*oak\b|\bmago\b|\bago\b/i, "AGO"],
  [/\bdove\b|\bdvo\b/i, "DVO"],
  [/\bapn\b|\baspen\b/i, "APN"],
  [/\bwhite\b|\bwht\b/i, "WHT"],
  [/\bcherry\b|\bch\b/i, "CH"],
  [/\boxblood\b|\boxb\b/i, "OXB"],
  [/\bbrushed\b|\bbru\b/i, "BRU"],
  [/\blight\s*gr[ae]y\b|\blgy\b/i, "LGY"],
  [/\bgr[ae]y\b|\bgry\b/i, "GRY"],
  [/\bblue\b|\bblu\b/i, "BLU"],
  [/\bgreen\b|\bgrn\b/i, "GRN"],
];

function normalizeSku(s: any): string {
  return String(s || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/-/g, "")
    .replace(/[.,;:]+$/, "")
    .trim();
}

function detectFinishFromText(text: string): string | null {
  if (!text) return null;
  for (const [re, suf] of COLOR_WORD_TO_SUFFIX) {
    if (re.test(text)) return suf;
  }
  return null;
}

function priceLevelMatch(unit: number, p: Record<string, any>) {
  // Compare against all level columns, tolerance = max($0.05, 0.15% of price).
  const levels: Array<[string, any]> = [
    ["L1", p.price_l1], ["L2", p.price_l2], ["L3", p.price_l3], ["L4", p.price_l4], ["L5", p.price_l5],
    ["showroom", p.price_showroom], ["list", p.list_price],
  ];
  const tol = Math.max(0.05, Math.abs(unit) * 0.0015);
  let best: { level: string; price: number; diff: number } | null = null;
  for (const [name, v] of levels) {
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    const diff = Math.abs(num - unit);
    if (diff <= tol) {
      // Prefer the lowest-numbered tier when multiple match (L1 over L2 over showroom).
      return { hit: name, price: num, diff };
    }
    if (best == null || diff < best.diff) best = { level: name, price: num, diff };
  }
  // No exact level — figure out if between showroom and list.
  const showroom = Number(p.price_showroom);
  const list = Number(p.list_price);
  const l1 = Number(p.price_l1);
  if (Number.isFinite(showroom) && Number.isFinite(list) && unit > Math.min(showroom, list) && unit < Math.max(showroom, list)) {
    return {
      hit: null,
      between: true,
      showroom: Number.isFinite(showroom) ? showroom : null,
      l1: Number.isFinite(l1) ? l1 : null,
      list: Number.isFinite(list) ? list : null,
      nearest: best,
    };
  }
  return { hit: null, between: false, nearest: best };
}

async function resolveSkus(supabase: any, lineItems: any[], emailText: string) {
  const norm = lineItems.map((li) => normalizeSku(li.sku));
  const uniqNorm = Array.from(new Set(norm.filter(Boolean)));

  // STEP 2 — exact matches (single round-trip).
  const exactMap: Record<string, any> = {};
  if (uniqNorm.length) {
    const { data: exact } = await supabase
      .from("price_list")
      .select("item, description, list_price, dealer_cost, er_cost, weight, mfg, price_l1, price_l2, price_l3, price_l4, price_l5, price_showroom")
      .in("item", uniqNorm)
      .limit(uniqNorm.length + 50);
    for (const r of exact || []) exactMap[normalizeSku(r.item)] = r;
  }

  // STEP 3 — crossref lookup for any line not matched exactly.
  const unmatchedAfterExact = uniqNorm.filter((s) => !exactMap[s]);
  const crossrefMap: Record<string, { ndi_sku: string; confidence: number; price: any }> = {};
  if (unmatchedAfterExact.length) {
    const { data: cx } = await supabase
      .from("sku_crossref")
      .select("competitor_sku, ndi_sku, confidence")
      .in("competitor_sku", unmatchedAfterExact)
      .limit(unmatchedAfterExact.length + 50);
    if (cx?.length) {
      const ndiSkus = Array.from(new Set(cx.map((r: any) => r.ndi_sku)));
      const { data: prices } = await supabase
        .from("price_list")
        .select("item, description, list_price, dealer_cost, er_cost, weight, mfg, price_l1, price_l2, price_l3, price_l4, price_l5, price_showroom")
        .in("item", ndiSkus)
        .limit(ndiSkus.length + 50);
      const priceMap: Record<string, any> = {};
      for (const p of prices || []) priceMap[String(p.item)] = p;
      // Prefer highest-confidence row per competitor sku.
      const byComp: Record<string, any> = {};
      for (const r of cx) {
        const prev = byComp[r.competitor_sku];
        if (!prev || Number(r.confidence ?? 1) > Number(prev.confidence ?? 1)) byComp[r.competitor_sku] = r;
      }
      for (const k of Object.keys(byComp)) {
        const r = byComp[k];
        const price = priceMap[r.ndi_sku];
        if (price) crossrefMap[k] = { ndi_sku: r.ndi_sku, confidence: Number(r.confidence ?? 1), price };
      }
    }
  }

  // STEP 4/5 — suffix completion + option-code insertion via single batched LIKE queries.
  // We additionally build trimmed variants of each normalized SKU (drop 1–4 trailing chars, min 5 remaining)
  // so junk trailing fragments like "-A3" don't blow up matching against PLTRBPOST28BRU.
  const unmatchedAfterCx = unmatchedAfterExact.filter((s) => !crossrefMap[s]);
  const trimVariants: Record<string, string[]> = {}; // nsku -> [trim1, trim2, ...]
  const allPrefixKeys = new Set<string>();
  for (const s of unmatchedAfterCx) {
    allPrefixKeys.add(s);
    const trims: string[] = [];
    for (let k = 1; k <= 4; k++) {
      const t = s.slice(0, s.length - k);
      if (t.length >= 5) { trims.push(t); allPrefixKeys.add(t); }
    }
    trimVariants[s] = trims;
  }

  const prefixMatchesByKey: Record<string, any[]> = {};
  if (allPrefixKeys.size) {
    const orExpr = Array.from(allPrefixKeys).map((s) => `item.ilike.${s}%`).join(",");
    const { data: cand } = await supabase
      .from("price_list")
      .select("item, description, list_price, dealer_cost, er_cost, weight, mfg, price_l1, price_l2, price_l3, price_l4, price_l5, price_showroom")
      .or(orExpr)
      .limit(4000);
    for (const r of cand || []) {
      const it = String(r.item).toUpperCase();
      for (const key of allPrefixKeys) {
        if (it.startsWith(key)) {
          if (!prefixMatchesByKey[key]) prefixMatchesByKey[key] = [];
          prefixMatchesByKey[key].push(r);
        }
      }
    }
  }

  const sortedSuf = [...FINISH_SUFFIXES].sort((a, b) => b.length - a.length);
  function labelCandidates(key: string, cands: any[]) {
    return cands.map((r) => {
      const item = String(r.item).toUpperCase();
      const tail = item.slice(key.length);
      let method: "suffix_unique" | "option_code" | null = null;
      let suffix: string | null = null;
      for (const suf of sortedSuf) {
        if (tail === suf) { method = "suffix_unique"; suffix = suf; break; }
      }
      if (!method) {
        for (const suf of sortedSuf) {
          if (tail.length > suf.length && tail.length <= suf.length + 3 && tail.endsWith(suf)) {
            method = "option_code"; suffix = suf; break;
          }
        }
      }
      return { row: r, item, tail, method, suffix };
    }).filter((x) => x.method != null);
  }

  // Build per-line result.
  return lineItems.map((li, idx) => {
    const nsku = norm[idx];
    const description = String(li.description || "");
    const out: any = {
      matched_sku: null,
      match_method: null,
      match_confidence: 0,
      candidates: [] as Array<{ item: string; description?: string }>,
      price_level: null,
      price_source: null,
      flags: [] as Array<{ field: string; issue: string; suggestion?: string; severity?: string }>,
      price_record: null,
    };

    if (!nsku) {
      out.flags.push({ field: `line[${idx}].sku`, issue: "Missing SKU", suggestion: "Cannot match without a SKU" });
      return out;
    }

    // Step 2: exact
    const exact = exactMap[nsku];
    if (exact) {
      out.matched_sku = exact.item; out.match_method = "exact"; out.match_confidence = 1.0;
      out.price_record = exact; out.price_source = "contract";
      return out;
    }

    // Step 3: crossref
    const cx = crossrefMap[nsku];
    if (cx) {
      out.matched_sku = cx.ndi_sku; out.match_method = "crossref"; out.match_confidence = cx.confidence;
      out.price_record = cx.price; out.price_source = "contract";
      return out;
    }

    // Helper: from a labeled set, decide whether to auto-apply or surface candidates.
    // `confidenceTable` returns confidence per match_method for the chosen suffix.
    const text = `${description} ${emailText || ""}`;
    function applyOrCandidates(
      labeled: ReturnType<typeof labelCandidates>,
      opts: { uniqueMethod?: "suffix_unique" | "option_code" | "trimmed_prefix"; trimmed?: boolean },
    ): "applied" | "ambiguous" | "empty" {
      if (labeled.length === 0) return "empty";
      if (labeled.length === 1) {
        const only = labeled[0];
        out.matched_sku = only.row.item;
        out.match_method = opts.trimmed ? "trimmed_prefix" : only.method!;
        out.match_confidence = opts.trimmed
          ? 0.7
          : only.method === "suffix_unique" ? 0.9 : 0.8;
        out.price_record = only.row;
        out.price_source = "contract";
        return "applied";
      }
      // Multiple: try color/finish resolution with ambiguity guard.
      // Only auto-resolve when EXACTLY ONE of the candidates' suffixes is mentioned in text.
      const candSuffixes = Array.from(new Set(labeled.map((x) => x.suffix).filter(Boolean) as string[]));
      const mentioned = new Set<string>();
      for (const [re, suf] of COLOR_WORD_TO_SUFFIX) {
        if (re.test(text) && candSuffixes.includes(suf)) mentioned.add(suf);
      }
      if (mentioned.size === 1 && !opts.trimmed) {
        const suf = Array.from(mentioned)[0];
        const hit = labeled.find((x) => x.suffix === suf);
        if (hit) {
          out.matched_sku = hit.row.item;
          out.match_method = "suffix_color_resolved";
          out.match_confidence = 0.85;
          out.price_record = hit.row;
          out.price_source = "contract";
          return "applied";
        }
      }
      // Ambiguous — surface candidates.
      out.candidates = labeled.slice(0, 6).map((x) => ({ item: x.row.item, description: x.row.description }));
      const why = opts.trimmed
        ? `Finish required (after trimming "${nsku}" → "${labeled[0].item.slice(0, labeled[0].item.length - (labeled[0].tail.length))}*") — candidates: ${out.candidates.map((c) => c.item).join(", ")}`
        : `Finish required — candidates: ${out.candidates.map((c) => c.item).join(", ")}`;
      out.flags.push({
        field: `line[${idx}].sku`,
        issue: why,
        suggestion: "Pick the correct finish/option to resolve",
        severity: "warning",
      });
      return "ambiguous";
    }

    // Step 4/5 on the original normalized SKU.
    const originalLabeled = labelCandidates(nsku, prefixMatchesByKey[nsku] || []);
    const res = applyOrCandidates(originalLabeled, {});
    if (res !== "empty") return out;

    // Step 4b — trimmed-prefix retry (drop 1–4 trailing chars, longest first).
    for (const trimKey of trimVariants[nsku] || []) {
      const labeled = labelCandidates(trimKey, prefixMatchesByKey[trimKey] || []);
      const r2 = applyOrCandidates(labeled, { trimmed: true });
      if (r2 !== "empty") return out;
    }

    return out; // still unresolved; description / catalog / e2g handled downstream.
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { email_content, attachments = [], customer_id } = await req.json() as {
      email_content: string;
      attachments?: Attachment[];
      customer_id?: string;
    };
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    // ---- AI extraction (unchanged) ----
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
          let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          b64 = btoa(bin);
        } catch (e) { console.error("Failed to fetch attachment", att.filename, e); continue; }
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
            ship_to: { type: "object", properties: { name: { type: "string" }, address: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" } } },
            line_items: {
              type: "array",
              items: { type: "object", properties: { sku: { type: "string" }, description: { type: "string" }, qty: { type: "number" }, unit_price: { type: "number" }, line_total: { type: "number" } }, required: ["sku","description","qty"] },
            },
            confidence: { type: "number" },
            flags: { type: "array", items: { type: "object", properties: { field: { type: "string" }, issue: { type: "string" }, suggestion: { type: "string" } }, required: ["field","issue","suggestion"] } },
          },
          required: ["customer_name","line_items","confidence","flags"],
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
      const txt = await r.text(); console.error("AI gateway error", r.status, txt);
      return new Response(JSON.stringify({ error: "AI parse failed" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const j = await r.json();
    const call = j.choices?.[0]?.message?.tool_calls?.[0];
    const parsed: any = call ? JSON.parse(call.function.arguments) : { customer_name: "Unknown", line_items: [], confidence: 0.3, flags: [{ field: "all", issue: "Could not parse", suggestion: "Manual entry required" }] };
    parsed.flags = parsed.flags || [];
    parsed.line_items = parsed.line_items || [];

    // ---- New pipeline ----
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

      // Customer price-level memory (lookup once).
      let customerLevel: { level: string; observed_count: number } | null = null;
      const custKey = (customer_id ?? parsed.customer_id ?? "").trim();
      if (custKey) {
        const { data: cpl } = await supabase
          .from("customer_price_levels")
          .select("price_level, observed_count")
          .eq("customer_id", custKey)
          .maybeSingle();
        if (cpl) customerLevel = { level: cpl.price_level, observed_count: cpl.observed_count };
      }

      // Resolve SKUs via the pipeline.
      const matches = await resolveSkus(supabase, parsed.line_items, email_content || "");

      // Bulk lookups for catalog / e2g fallback (preserve existing behavior, lower priority).
      const stillUnresolved = parsed.line_items
        .map((li: any, i: number) => ({ i, sku: normalizeSku(li.sku) }))
        .filter(({ i }) => !matches[i].matched_sku);
      const unresolvedSkus = Array.from(new Set(stillUnresolved.map((x) => x.sku).filter(Boolean)));

      let catalogMap: Record<string, any> = {};
      let e2gMap: Record<string, any> = {};
      if (unresolvedSkus.length) {
        const { data: cat } = await supabase
          .from("catalog_items")
          .select("sku, description, list_price, mfg, page, catalog_id")
          .in("sku", unresolvedSkus)
          .limit(unresolvedSkus.length + 50);
        for (const c of cat || []) catalogMap[String(c.sku)] = c;
        const { data: e2g } = await supabase
          .from("e2g_inventory_snapshot")
          .select("item_id, item_desc, e2g_price, total")
          .in("item_id", unresolvedSkus)
          .limit(unresolvedSkus.length + 50);
        for (const e of e2g || []) e2gMap[String(e.item_id)] = e;
      }

      // Step 6 — description fallback for lines unresolved after suffix + trimmed-prefix retries.
      // One batched query: OR together distinctive tokens (dimensions + 4+ char content words)
      // from every unresolved line, then score each result by per-line token overlap.
      const STOPWORDS = new Set([
        "WITH","AND","FOR","THE","FROM","INTO","FRONT","BACK","SIDE","TOP","NEW","ITEM","PART","COLOR","COLOUR","FINISH","FRAME","BASE","UNIT","INCLUDED","STD","STANDARD",
      ]);
      function lineTokens(desc: string): string[] {
        if (!desc) return [];
        const tokens = new Set<string>();
        // Dimension patterns: 71"W, 36"D, 29"H, 71"W/36"D, 5'10", etc.
        const dims = desc.match(/\d+(?:\.\d+)?\s*["']\s*[WDHwdh]?/g) || [];
        for (const d of dims) tokens.add(d.replace(/\s+/g, "").toUpperCase());
        // 4+ char words (alphanumeric).
        const words = desc.toUpperCase().match(/[A-Z][A-Z0-9-]{3,}/g) || [];
        for (const w of words) if (!STOPWORDS.has(w) && w.length >= 4) tokens.add(w);
        return Array.from(tokens).slice(0, 6);
      }
      const lineTokensByIdx: Record<number, string[]> = {};
      const allTokens = new Set<string>();
      for (const { i } of stillUnresolved) {
        if (matches[i].candidates?.length) continue; // already has prefix candidates — skip
        const desc = String((parsed.line_items[i] as any).description || "");
        const toks = lineTokens(desc);
        if (toks.length) {
          lineTokensByIdx[i] = toks;
          for (const t of toks) allTokens.add(t);
        }
      }
      const descCandsByIdx: Record<number, Array<{ item: string; description?: string }>> = {};
      if (allTokens.size) {
        const orExpr = Array.from(allTokens).slice(0, 30).map((t) => {
          // Escape PostgREST commas / parens inside the pattern by replacing them — safest: drop
          const safe = t.replace(/[(),%]/g, "");
          return `description.ilike.%${safe}%`;
        }).join(",");
        const { data: descRows } = await supabase
          .from("price_list")
          .select("item, description")
          .or(orExpr)
          .limit(500);
        // Score per line.
        for (const idx of Object.keys(lineTokensByIdx)) {
          const i = Number(idx);
          const toks = lineTokensByIdx[i];
          const scored: Array<{ item: string; description?: string; score: number }> = [];
          for (const r of descRows || []) {
            const d = String(r.description || "").toUpperCase();
            let score = 0;
            for (const t of toks) if (d.includes(t)) score++;
            if (score > 0) scored.push({ item: r.item, description: r.description, score });
          }
          scored.sort((a, b) => b.score - a.score);
          if (scored.length) {
            descCandsByIdx[i] = scored.slice(0, 3).map((s) => ({ item: s.item, description: s.description }));
          }
        }
      }


      let observedLevels: string[] = [];
      let unknownCount = 0;

      parsed.line_items.forEach((li: any, i: number) => {
        const m = matches[i];
        const unit = Number(li.unit_price);
        const description = String(li.description || "");

        // Apply matched contract price.
        if (m.matched_sku && m.price_record) {
          const pr = m.price_record;
          li.price_list_match = {
            list_price: pr.list_price,
            dealer_cost: pr.dealer_cost,
            er_cost: pr.er_cost,
            mfg: pr.mfg,
            description: pr.description,
            source: "contract",
            matched_sku: m.matched_sku,
            match_method: m.match_method,
            match_confidence: m.match_confidence,
            price_l1: pr.price_l1, price_l2: pr.price_l2, price_l3: pr.price_l3,
            price_l4: pr.price_l4, price_l5: pr.price_l5, price_showroom: pr.price_showroom,
          };

          if (Number.isFinite(unit)) {
            const plm = priceLevelMatch(unit, pr);
            if (plm.hit) {
              li.price_list_match.price_level = plm.hit;
              observedLevels.push(plm.hit);
            } else if (plm.between) {
              li.price_list_match.price_level = null;
              parsed.flags.push({
                field: `line[${i}].unit_price`,
                issue: `Price $${unit.toFixed(2)} is off-schedule (between showroom $${plm.showroom?.toFixed?.(2) ?? "?"} and L1 $${plm.l1?.toFixed?.(2) ?? "?"}) — likely contract or price-match deal; verify against customer agreement.`,
                suggestion: "Verify customer agreement",
                type: "contract_or_price_match",
                severity: "info",
              });
            } else if (plm.nearest) {
              const dir = unit < plm.nearest.price ? "below" : "above";
              parsed.flags.push({
                field: `line[${i}].unit_price`,
                issue: `Price $${unit.toFixed(2)} is ${dir} all tiers — nearest is ${plm.nearest.level} $${plm.nearest.price.toFixed(2)}`,
                suggestion: "Confirm pricing before submitting",
                type: "price_error",
                severity: "error",
              });
            }
          } else {
            // Missing unit_price — pre-fill if we know customer's usual level.
            if (customerLevel) {
              const key = ({ L1: "price_l1", L2: "price_l2", L3: "price_l3", L4: "price_l4", L5: "price_l5", showroom: "price_showroom", list: "list_price" } as any)[customerLevel.level];
              const guess = key ? Number(pr[key]) : NaN;
              if (Number.isFinite(guess)) {
                li.unit_price = guess;
                li.price_list_match.price_level = customerLevel.level;
                li.price_list_match.price_filled_from_customer = true;
                parsed.flags.push({
                  field: `line[${i}].unit_price`,
                  issue: `Price filled from customer's usual level ${customerLevel.level} — confirm`,
                  suggestion: "Verify before submitting",
                  severity: "info",
                });
              }
            }
          }

          for (const f of m.flags) parsed.flags.push(f);
          return;
        }

        // Surface pipeline candidates / partial info even when unmatched.
        if (m.candidates?.length) {
          li.price_list_match = {
            source: "candidates",
            match_method: "ambiguous",
            candidates: m.candidates,
          };
          for (const f of m.flags) parsed.flags.push(f);
          return;
        }

        // Step 6: description fallback candidates (never auto-applied).
        const descCands = descCandsByIdx[i];
        if (descCands?.length) {
          li.price_list_match = {
            source: "candidates",
            match_method: "description",
            candidates: descCands,
          };
          parsed.flags.push({
            field: `line[${i}].sku`,
            issue: `SKU ${li.sku} not found — best description matches: ${descCands.map((c) => c.item).join(", ")}`,
            suggestion: "Pick the correct item or add a sku_crossref mapping",
            severity: "warning",
          });
          return;
        }


        // Fallback: catalog_items
        const cat = catalogMap[normalizeSku(li.sku)];
        if (cat) {
          li.price_list_match = {
            list_price: cat.list_price, description: cat.description, mfg: cat.mfg, page: cat.page,
            source: "catalog", match_method: "catalog", match_confidence: 0.5,
          };
          parsed.flags.push({
            field: `line[${i}].sku`,
            issue: `SKU ${li.sku} found in catalog (page ${cat.page ?? "?"}) but no contract price on file`,
            suggestion: "Confirm pricing with sales before submitting",
          });
          return;
        }

        // Fallback: E2G
        const e2g = e2gMap[normalizeSku(li.sku)];
        if (e2g) {
          li.price_list_match = {
            list_price: e2g.e2g_price, description: e2g.item_desc, source: "e2g", stock: e2g.total,
            match_method: "e2g", match_confidence: 0.5,
          };
          parsed.flags.push({
            field: `line[${i}].sku`,
            issue: `SKU ${li.sku} priced from E2G inventory upload (no contract price)`,
            suggestion: "Verify pricing before submitting",
          });
          return;
        }

        // Truly unresolved.
        parsed.flags.push({
          field: `line[${i}].sku`,
          issue: `Not found — possible competitor SKU "${li.sku}"`,
          suggestion: "Add a sku_crossref mapping once resolved",
          severity: "error",
          type: "unresolved_sku",
        });
        unknownCount++;
      });

      // Confidence floor when too many unresolved.
      const totalLines = parsed.line_items.length || 1;
      if (unknownCount / totalLines > 0.2) {
        parsed.confidence = Math.min(parsed.confidence ?? 0.5, 0.6);
      }

      // Update customer_price_levels if we saw a consistent level across lines.
      if (custKey && observedLevels.length) {
        const counts: Record<string, number> = {};
        for (const l of observedLevels) counts[l] = (counts[l] || 0) + 1;
        const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        const winnerLevel = winner?.[0];
        const winnerCount = winner?.[1] ?? 0;
        // Require the dominant level to cover >=60% of priced lines AND >=2 lines (to avoid noise).
        if (winnerLevel && winnerCount >= 2 && winnerCount / observedLevels.length >= 0.6) {
          await supabase.from("customer_price_levels").upsert({
            customer_id: custKey,
            customer_name: parsed.customer_name ?? null,
            price_level: winnerLevel,
            observed_count: (customerLevel?.observed_count ?? 0) + 1,
            last_seen_at: new Date().toISOString(),
          }, { onConflict: "customer_id" });
        }

        // Flag deviation if customer had a known level and most lines disagree.
        if (customerLevel && winnerLevel && winnerLevel !== customerLevel.level) {
          parsed.flags.push({
            field: "all",
            issue: `Pricing landed on ${winnerLevel} but this customer usually buys at ${customerLevel.level}`,
            suggestion: "Verify the level/contract for this PO",
            severity: "warning",
            type: "level_deviation",
          });
        }
      }
    } catch (e) {
      console.error("SKU pipeline failed", e);
    }

    return new Response(JSON.stringify({ parsed }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
