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

export type FamilyRow = {
  id: string;
  item: string;
  mfg?: string | null;
  category?: string | null;
  list_price?: number | null;
  price_l1?: number | null;
  price_l2?: number | null;
  price_l3?: number | null;
  price_l4?: number | null;
  price_l5?: number | null;
};

function priceTupleKey(r: FamilyRow): string {
  return [
    r.mfg ?? "",
    r.category ?? "",
    r.list_price ?? "",
    r.price_l1 ?? "",
    r.price_l2 ?? "",
    r.price_l3 ?? "",
    r.price_l4 ?? "",
    r.price_l5 ?? "",
  ].join("|");
}

/**
 * Pure family labelling. Groups by (mfg, category, list, L1..L5). A multi-member
 * group shares commonPrefix only if it is >= 4 chars and >= 60% of the group's
 * shortest item; otherwise members keep their own item. Any label that ends up
 * spanning more than one price group makes every member of those groups fall
 * back to its own item. Returns id -> item_short.
 */
export function computeFamilyLabels(rows: FamilyRow[]): Map<string, string> {
  const groups = new Map<string, FamilyRow[]>();
  for (const r of rows) {
    const k = priceTupleKey(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  // Per group: one shared label, or null = members use their own item.
  const shared = new Map<string, string | null>();
  for (const [k, members] of groups) {
    if (members.length === 1) { shared.set(k, null); continue; }
    const items = members.map((m) => m.item);
    const name = commonPrefix(items) || "";
    const shortest = Math.min(...items.map((s) => s.length));
    shared.set(k, name.length >= 4 && name.length >= 0.6 * shortest ? name : null);
  }

  const labelsOf = (k: string): string[] => {
    const s = shared.get(k);
    return s != null ? [s] : groups.get(k)!.map((m) => m.item);
  };
  const collisions = () => {
    const owners = new Map<string, Set<string>>();
    for (const k of groups.keys()) {
      for (const l of labelsOf(k)) {
        const set = owners.get(l) ?? new Set<string>();
        set.add(k);
        owners.set(l, set);
      }
    }
    const bad = new Set<string>();
    for (const set of owners.values()) if (set.size > 1) for (const k of set) bad.add(k);
    return bad;
  };

  // Each pass only turns shared labels into own items, so this terminates
  // within groups.size passes; own items are unique in price_list.
  for (let pass = 0; pass <= groups.size; pass++) {
    const bad = collisions();
    const fixable = [...bad].filter((k) => shared.get(k) != null);
    if (fixable.length === 0) break;
    for (const k of fixable) shared.set(k, null);
  }
  const remaining = [...collisions()].filter((k) => shared.get(k) != null);
  if (remaining.length > 0) {
    throw new Error(`computeFamilyLabels: ${remaining.length} shared labels still span more than one price group`);
  }

  const out = new Map<string, string>();
  for (const [k, members] of groups) {
    const s = shared.get(k);
    for (const m of members) out.set(m.id, s ?? m.item);
  }
  return out;
}

export type RecomputeFamiliesResult = { updated: number; failed: number; changed: number; cap: number; skipped?: string };


export async function recomputeFamilies(opts?: { force?: boolean }): Promise<RecomputeFamiliesResult> {
  // Complete-or-throw: every price_list row, not PostgREST's 1,000-row cap.
  const { fetchAllRows } = await import("./supabase-fetch-all");
  const rows = await fetchAllRows<any>(
    () =>
      supabaseAdmin
        .from("price_list")
        .select("id,item,mfg,category,list_price,price_l1,price_l2,price_l3,price_l4,price_l5,item_short", { count: "exact" }) as any,
    { label: "recomputeFamilies price_list", orderBy: [{ column: "id" }], concurrency: 4 },
  );

  const labels = computeFamilyLabels(rows as FamilyRow[]);
  const changed: { id: string; item_short: string }[] = [];
  for (const r of rows) {
    const next = labels.get(r.id as string)!;
    if ((r.item_short ?? null) !== next) changed.push({ id: r.id as string, item_short: next });
  }

  // Change cap: a mass relabel needs an explicitly approved forced run.
  const cap = Math.max(500, Math.floor(rows.length * 0.05));
  if (changed.length > cap && !opts?.force) {
    const skipped = `family relabel would change ${changed.length} of ${rows.length} rows (cap ${cap}); nothing written`;
    console.warn(`[pricer.families] ${skipped}`);
    return { updated: 0, failed: 0, changed: changed.length, cap, skipped };
  }

  let updated = 0;
  let failed = 0;
  const CONCURRENCY = 25;
  for (let i = 0; i < changed.length; i += 500) {
    const batch = changed.slice(i, i + 500);
    for (let j = 0; j < batch.length; j += CONCURRENCY) {
      const results = await Promise.all(
        batch.slice(j, j + CONCURRENCY).map(async (u) => {
          try {
            const { error } = await supabaseAdmin.from("price_list").update({ item_short: u.item_short }).eq("id", u.id);
            return !error;
          } catch {
            return false;
          }
        }),
      );
      for (const ok of results) ok ? updated++ : failed++;
    }
  }
  if (failed > 0) {
    throw new Error(`recomputeFamilies: ${failed} of ${changed.length} updates failed (${updated} succeeded)`);
  }
  return { updated, failed, changed: changed.length, cap };
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
  search?: string | null;
}): Promise<PricerRow[]> {
  const { fetchAllRows } = await import("./supabase-fetch-all");
  const rows = await fetchAllRows<any>(
    () => {
      let q = supabaseAdmin
        .from("price_list")
        .select("item,item_short,description,mfg,category,list_price,price_l1,price_l2,price_l3,price_l4,price_l5", { count: "exact" })
        .not("item_short", "is", null);
      if (filters.category) q = q.eq("category", filters.category);
      if (filters.mfg) q = q.eq("mfg", filters.mfg);
      if (filters.search) {
        const esc = filters.search.replace(/[%,()]/g, " ");
        q = q.or(`item.ilike.%${esc}%,item_short.ilike.%${esc}%,description.ilike.%${esc}%`);
      }
      return q as any;
    },
    { label: "loadPricerRows price_list", orderBy: [{ column: "item_short" }, { column: "item" }, { column: "id" }], concurrency: 4 },
  );

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
