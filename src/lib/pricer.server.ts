// Server-only helpers for the Pricer module: family derivation, image probing,
// PDF rendering. Never import this from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const PRICE_LEVELS = ["list", "l1", "l2", "l3", "l4", "l5"] as const;
export type PriceLevel = (typeof PRICE_LEVELS)[number];
export const LEVEL_LABEL: Record<PriceLevel, string> = {
  list: "List",
  l1: "L1",
  l2: "L2",
  l3: "L3",
  l4: "L4",
  l5: "L5",
};
export const LEVEL_COLUMN: Record<PriceLevel, string> = {
  list: "list_price",
  l1: "price_l1",
  l2: "price_l2",
  l3: "price_l3",
  l4: "price_l4",
  l5: "price_l5",
};

const IMAGE_BASE = "https://ndiofficefurniture.net/images";

// Longest common alphabetic prefix across SKUs in the same group. Numbers stay,
// trailing color/finish letters fall off (e.g. PL102APN, PL102CGY -> PL102).
function commonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  let prefix = items[0];
  for (const s of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
  }
  // Trim trailing trailing alpha-only chunk if the original SKUs end in
  // letters (the "finish" suffix). Keeps numeric/alphanumeric stems intact.
  const trimmed = prefix.replace(/[A-Za-z]+$/, "");
  return trimmed.length >= 2 ? trimmed : prefix;
}

export async function recomputeFamilies(): Promise<{ updated: number }> {
  // Pull every row's identifying fields + pricing tuple. Group within
  // mfg/category by identical 6-level price tuple, derive item_short.
  const { data, error } = await supabaseAdmin
    .from("price_list")
    .select(
      "id,item,mfg,category,list_price,price_l1,price_l2,price_l3,price_l4,price_l5,item_short"
    )
    .limit(20000);
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  const groups = new Map<string, { id: string; item: string }[]>();
  for (const r of rows) {
    const key = [
      r.mfg ?? "",
      r.category ?? "",
      r.list_price ?? "",
      r.price_l1 ?? "",
      r.price_l2 ?? "",
      r.price_l3 ?? "",
      r.price_l4 ?? "",
      r.price_l5 ?? "",
    ].join("|");
    const arr = groups.get(key) ?? [];
    arr.push({ id: r.id as string, item: r.item as string });
    groups.set(key, arr);
  }

  const updates: { id: string; item_short: string }[] = [];
  for (const [, members] of groups) {
    const items = members.map((m) => m.item);
    const family = members.length === 1 ? items[0] : commonPrefix(items) || items[0];
    for (const m of members) updates.push({ id: m.id, item_short: family });
  }

  // Apply only where it changes, in batches.
  const byId = new Map(rows.map((r) => [r.id as string, r.item_short as string | null]));
  const changed = updates.filter((u) => byId.get(u.id) !== u.item_short);
  for (let i = 0; i < changed.length; i += 500) {
    const batch = changed.slice(i, i + 500);
    await Promise.all(
      batch.map((u) =>
        supabaseAdmin.from("price_list").update({ item_short: u.item_short }).eq("id", u.id)
      )
    );
  }
  return { updated: changed.length };
}

export async function probeImage(sku: string): Promise<"reachable" | "not_found" | "error"> {
  const url = `${IMAGE_BASE}/${sku}.jpg`;
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok ? "reachable" : "not_found";
  } catch {
    return "error";
  }
}

export async function probeFamily(familyItems: string[]): Promise<{ sku: string; status: string } | null> {
  for (const sku of familyItems) {
    const url = `${IMAGE_BASE}/${sku}.jpg`;
    const status = await probeImage(sku);
    await supabaseAdmin
      .from("sku_image_cache")
      .upsert({ full_sku: sku, image_url: url, status, checked_at: new Date().toISOString() });
    if (status === "reachable") return { sku, status };
  }
  return null;
}

export function imageUrlFor(sku: string): string {
  return `${IMAGE_BASE}/${sku}.jpg`;
}

export type PricerRow = {
  item_short: string;
  rep_item: string;
  description: string | null;
  finishes: string[];
  list_price: number | null;
  l1: number | null;
  l2: number | null;
  l3: number | null;
  l4: number | null;
  l5: number | null;
  image_url: string | null;
};

export async function loadPricerRows(filters: {
  category?: string | null;
  mfg?: string | null;
  in_stock_only?: boolean;
  search?: string | null;
}): Promise<PricerRow[]> {
  let q = supabaseAdmin
    .from("price_list")
    .select(
      "item,item_short,description,mfg,category,list_price,price_l1,price_l2,price_l3,price_l4,price_l5"
    )
    .not("item_short", "is", null)
    .order("item_short", { ascending: true })
    .order("item", { ascending: true })
    .limit(20000);
  if (filters.category) q = q.eq("category", filters.category);
  if (filters.mfg) q = q.eq("mfg", filters.mfg);
  if (filters.search) {
    const esc = filters.search.replace(/[%,()]/g, " ");
    q = q.or(`item.ilike.%${esc}%,item_short.ilike.%${esc}%,description.ilike.%${esc}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];

  // Optional in-stock restriction
  let stockSet: Set<string> | null = null;
  if (filters.in_stock_only) {
    const { data: stock } = await supabaseAdmin
      .from("e2g_inventory_snapshot")
      .select("item_id,total")
      .gt("total", 0)
      .limit(20000);
    stockSet = new Set((stock ?? []).map((s) => s.item_id as string));
  }

  // Cached image lookups for all candidate SKUs
  const allSkus = rows.map((r) => r.item as string);
  const cacheBatch = new Set<string>();
  for (let i = 0; i < allSkus.length; i += 500) cacheBatch.add(allSkus.slice(i, i + 500).join(","));
  const { data: cached } = await supabaseAdmin
    .from("sku_image_cache")
    .select("full_sku,image_url,status")
    .in("full_sku", allSkus.slice(0, 5000));
  const cacheMap = new Map<string, { image_url: string; status: string }>();
  for (const c of cached ?? [])
    cacheMap.set(c.full_sku as string, { image_url: c.image_url as string, status: c.status as string });

  const { data: overrides } = await supabaseAdmin
    .from("sku_family_image_overrides")
    .select("item_short,image_path");
  const overrideMap = new Map<string, string>();
  for (const o of overrides ?? []) overrideMap.set(o.item_short as string, o.image_path as string);

  const families = new Map<string, PricerRow>();
  for (const r of rows) {
    const itemShort = r.item_short as string;
    if (stockSet && !stockSet.has(r.item as string)) continue;
    let fam = families.get(itemShort);
    if (!fam) {
      fam = {
        item_short: itemShort,
        rep_item: r.item as string,
        description: r.description as string | null,
        finishes: [],
        list_price: r.list_price as number | null,
        l1: r.price_l1 as number | null,
        l2: r.price_l2 as number | null,
        l3: r.price_l3 as number | null,
        l4: r.price_l4 as number | null,
        l5: r.price_l5 as number | null,
        image_url: null,
      };
      families.set(itemShort, fam);
    }
    // Finish suffix is what's left after stripping item_short prefix
    const fullSku = r.item as string;
    const suffix = fullSku.startsWith(itemShort) ? fullSku.slice(itemShort.length) : fullSku;
    if (suffix && !fam.finishes.includes(suffix)) fam.finishes.push(suffix);

    if (!fam.image_url) {
      const ovr = overrideMap.get(itemShort);
      if (ovr) {
        fam.image_url = ovr.startsWith("http")
          ? ovr
          : `${process.env.SUPABASE_URL}/storage/v1/object/public/pricer-images/${ovr}`;
      } else {
        const c = cacheMap.get(fullSku);
        if (c && c.status === "reachable") fam.image_url = c.image_url;
      }
    }
  }
  return Array.from(families.values());
}
