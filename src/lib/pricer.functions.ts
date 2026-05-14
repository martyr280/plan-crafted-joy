import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recomputeFamilies, probeFamily, imageUrlFor, loadPricerRows, PRICE_LEVELS } from "./pricer.server";
import { renderPricerPdf } from "./pricer.pdf";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin")) throw new Error("Admin role required");
}

export const recomputeSkuFamilies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    return await recomputeFamilies();
  });

export const listSkuFamilies = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ search: z.string().optional() }).parse)
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("price_list")
      .select("item,item_short,description,mfg,category,list_price,price_l1,price_l2,price_l3,price_l4,price_l5")
      .not("item_short", "is", null)
      .order("item_short", { ascending: true })
      .limit(20000);
    if (data.search) {
      const esc = data.search.replace(/[%,()]/g, " ");
      q = q.or(`item.ilike.%${esc}%,item_short.ilike.%${esc}%,description.ilike.%${esc}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    // Group by item_short
    const families = new Map<string, { item_short: string; rep: any; count: number; finishes: string[]; missingLevels: string[] }>();
    for (const r of rows ?? []) {
      const fs = r.item_short as string;
      let f = families.get(fs);
      if (!f) {
        const missing: string[] = [];
        for (const lvl of PRICE_LEVELS) {
          const col = lvl === "list" ? "list_price" : `price_${lvl}`;
          if ((r as any)[col] == null) missing.push(lvl);
        }
        f = { item_short: fs, rep: r, count: 0, finishes: [], missingLevels: missing };
        families.set(fs, f);
      }
      f.count += 1;
      const sfx = (r.item as string).startsWith(fs) ? (r.item as string).slice(fs.length) : (r.item as string);
      if (sfx && !f.finishes.includes(sfx)) f.finishes.push(sfx);
    }
    return { families: Array.from(families.values()) };
  });

export const updateSkuFamily = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ item: z.string(), item_short: z.string().min(1) }).parse)
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin.from("price_list").update({ item_short: data.item_short }).eq("item", data.item);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateFamilyPrices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      item_short: z.string(),
      list_price: z.number().nullable().optional(),
      price_l1: z.number().nullable().optional(),
      price_l2: z.number().nullable().optional(),
      price_l3: z.number().nullable().optional(),
      price_l4: z.number().nullable().optional(),
      price_l5: z.number().nullable().optional(),
    }).parse
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { item_short, ...prices } = data;
    const patch: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(prices)) if (v !== undefined) patch[k] = v as number | null;
    const { error } = await supabaseAdmin.from("price_list").update(patch).eq("item_short", item_short);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const probeFamilyImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ item_short: z.string() }).parse)
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { data: members } = await supabaseAdmin
      .from("price_list").select("item").eq("item_short", data.item_short).limit(50);
    const skus = (members ?? []).map((m) => m.item as string);
    const result = await probeFamily(skus);
    return { sku: result?.sku ?? null, url: result ? imageUrlFor(result.sku) : null };
  });

export const listFamilyImages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ filter: z.enum(["all", "missing"]).default("all") }).parse)
  .handler(async ({ data }) => {
    const { data: rows } = await supabaseAdmin
      .from("price_list").select("item,item_short").not("item_short", "is", null).limit(20000);
    const families = new Map<string, string[]>();
    for (const r of rows ?? []) {
      const fs = r.item_short as string;
      const arr = families.get(fs) ?? [];
      arr.push(r.item as string);
      families.set(fs, arr);
    }
    const allSkus = Array.from(new Set((rows ?? []).map((r) => r.item as string)));
    const { data: cached } = await supabaseAdmin
      .from("sku_image_cache").select("full_sku,image_url,status").in("full_sku", allSkus.slice(0, 5000));
    const cmap = new Map((cached ?? []).map((c) => [c.full_sku as string, c]));
    const { data: overrides } = await supabaseAdmin
      .from("sku_family_image_overrides").select("item_short,image_path");
    const omap = new Map((overrides ?? []).map((o) => [o.item_short as string, o.image_path as string]));
    const out = Array.from(families.entries()).map(([item_short, members]) => {
      let live: string | null = null;
      for (const sku of members) {
        const c = cmap.get(sku);
        if (c?.status === "reachable") { live = c.image_url as string; break; }
      }
      const override = omap.get(item_short) ?? null;
      const overrideUrl = override
        ? (override.startsWith("http") ? override : `${process.env.SUPABASE_URL}/storage/v1/object/public/pricer-images/${override}`)
        : null;
      return { item_short, member_count: members.length, sample: members.slice(0, 5), live_url: live, override_url: overrideUrl };
    }).sort((a, b) => a.item_short.localeCompare(b.item_short));
    return { families: data.filter === "missing" ? out.filter((x) => !x.live_url && !x.override_url) : out };
  });

export const generatePricerPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      name: z.string().min(1).max(120),
      orientation: z.enum(["landscape", "portrait"]),
      portrait_level: z.enum(["list", "l1", "l2", "l3", "l4", "l5"]).nullable().optional(),
      filters: z.object({
        category: z.string().nullable().optional(),
        mfg: z.string().nullable().optional(),
        in_stock_only: z.boolean().optional(),
        search: z.string().nullable().optional(),
      }).default({}),
    }).parse
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { data: pubRow, error: pubErr } = await supabaseAdmin
      .from("pricer_publications")
      .insert({
        name: data.name,
        orientation: data.orientation,
        portrait_level: data.orientation === "portrait" ? data.portrait_level ?? "list" : null,
        filters: data.filters,
        status: "running",
        generated_by: context.userId,
      })
      .select("id").single();
    if (pubErr || !pubRow) throw new Error(pubErr?.message ?? "Failed to create publication row");
    const pubId = pubRow.id as string;

    try {
      const rows = await loadPricerRows(data.filters);
      if (rows.length === 0) throw new Error("No rows match the filters");
      const buf = await renderPricerPdf({
        rows,
        name: data.name,
        orientation: data.orientation,
        level: data.orientation === "portrait" ? (data.portrait_level ?? "list") : null,
      });
      const path = `${pubId}/${data.name.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
      const { error: upErr } = await supabaseAdmin.storage
        .from("pricer-pdfs")
        .upload(path, buf, { contentType: "application/pdf", upsert: true });
      if (upErr) throw new Error(upErr.message);
      await supabaseAdmin.from("pricer_publications").update({
        pdf_path: path, row_count: rows.length, status: "ready",
      }).eq("id", pubId);
      return { id: pubId, pdf_path: path, row_count: rows.length };
    } catch (e: any) {
      await supabaseAdmin.from("pricer_publications").update({ status: "error", error: e.message }).eq("id", pubId);
      throw e;
    }
  });

export const listPricerPublications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("pricer_publications")
      .select("*")
      .order("generated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    // sign URLs for ready ones
    const out = await Promise.all((data ?? []).map(async (p: any) => {
      let signed: string | null = null;
      if (p.pdf_path) {
        const { data: s } = await supabaseAdmin.storage.from("pricer-pdfs").createSignedUrl(p.pdf_path, 3600);
        signed = s?.signedUrl ?? null;
      }
      return { ...p, signed_url: signed };
    }));
    return { publications: out };
  });

export const listPricerFilters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data } = await supabaseAdmin.from("price_list").select("category,mfg").limit(20000);
    const cats = new Set<string>(), mfgs = new Set<string>();
    for (const r of data ?? []) {
      if (r.category) cats.add(r.category as string);
      if (r.mfg) mfgs.add(r.mfg as string);
    }
    return { categories: Array.from(cats).sort(), mfgs: Array.from(mfgs).sort() };
  });
