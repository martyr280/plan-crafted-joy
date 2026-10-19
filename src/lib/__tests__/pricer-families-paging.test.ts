import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const st = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>,
  ranges: [] as Array<[number, number]>,
  orders: [] as string[],
  selects: [] as Array<[string, any]>,
  updates: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q: any = {
        select: (c: string, o: any) => { st.selects.push([c, o]); return q; },
        order: (c: string) => { st.orders.push(c); return q; },
        range: async (f: number, t: number) => {
          st.ranges.push([f, t]);
          return { data: st.rows.slice(f, t + 1), error: null, count: st.rows.length };
        },
        update: () => ({ eq: async () => { st.updates++; return { error: null }; } }),
      };
      return q;
    },
  },
}));

import { recomputeFamilies } from "../pricer.server";

beforeEach(() => { st.rows = []; st.ranges = []; st.orders = []; st.selects = []; st.updates = 0; });

describe("recomputeFamilies reads the full price list", () => {
  it("reads all 16,185 rows through the shared pager (17 pages, order id, count exact)", async () => {
    // Every row is its own family and already labelled, so no updates fire.
    st.rows = Array.from({ length: 16185 }, (_, i) => ({ id: `id-${i}`, item: `SKU${i}`, mfg: `M${i}`, item_short: `SKU${i}` }));
    const res = await recomputeFamilies();
    expect(st.ranges.length).toBe(17);
    expect(st.ranges.at(-1)).toEqual([16000, 16999]);
    expect(new Set(st.orders)).toEqual(new Set(["id"]));
    expect(st.selects.every(([c, o]) => c === "id,item,mfg,category,list_price,price_l1,price_l2,price_l3,price_l4,price_l5,item_short" && o.count === "exact")).toBe(true);
    expect(res.updated).toBe(0);
    expect(st.updates).toBe(0);
  });

  it("a row beyond 1,000 is grouped: two same-price rows on separate pages share a family", async () => {
    st.rows = Array.from({ length: 1500 }, (_, i) => ({ id: `id-${i}`, item: `U${i}`, mfg: `M${i}`, item_short: `U${i}` }));
    st.rows[10] = { id: "id-10", item: "ABC-RED", mfg: "X", list_price: 5, item_short: "ABC-RED" };
    st.rows[1400] = { id: "id-1400", item: "ABC-BLU", mfg: "X", list_price: 5, item_short: "ABC-BLU" };
    const res = await recomputeFamilies();
    expect(res.updated).toBe(2);
  });
});

describe("pricer.server wiring", () => {
  const src = readFileSync("src/lib/pricer.server.ts", "utf8");
  const block = (label: string) => {
    const end = src.indexOf(`label: "${label}"`);
    expect(end).toBeGreaterThan(0);
    return src.slice(src.lastIndexOf("fetchAllRows<", end), src.indexOf("\n", end));
  };
  it("recomputeFamilies: count exact, orderBy [id], concurrency 4, no .limit", () => {
    const b = block("recomputeFamilies price_list");
    expect(b).toContain('{ count: "exact" }');
    expect(b).toContain('orderBy: [{ column: "id" }], concurrency: 4');
    expect(b).not.toMatch(/\.limit\(|\.range\(|\.order\(/);
  });
  it("loadPricerRows: count exact, orderBy [item_short, item, id], filters kept, no .limit", () => {
    const b = block("loadPricerRows price_list");
    expect(b).toContain('{ count: "exact" }');
    expect(b).toContain('orderBy: [{ column: "item_short" }, { column: "item" }, { column: "id" }]');
    expect(b).toContain('q = q.eq("category", filters.category)');
    expect(b).toContain("q = q.or(`item.ilike.%${esc}%");
    expect(b).not.toMatch(/\.limit\(|\.range\(|\.order\(/);
  });
  it("no .limit( remains in pricer.server.ts", () => {
    expect(src).not.toMatch(/\.limit\(/);
  });
});
