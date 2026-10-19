import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked backend: the bridge job (runJob) answers instantly with `pull`,
// price_list holds `existing` p21_sql rows, and every delete is recorded.
const st = vi.hoisted(() => ({
  pull: [] as Array<Record<string, any>>,
  existing: [] as Array<{ id: string; item: string }>,
  deletes: [] as Array<{ items: string[]; eq: Array<[string, any]> }>,
  ranges: [] as Array<[number, number]>,
  famArgs: [] as unknown[][],
  famResult: { updated: 0, failed: 0, changed: 0 } as Record<string, any>,
  events: [] as Array<Record<string, any>>,
}));

vi.mock("../pricer.server", () => ({
  recomputeFamilies: async (...args: unknown[]) => { st.famArgs.push(args); return st.famResult; },
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    if (table === "p21_bridge_jobs") {
      const q: any = {
        insert: () => q, select: () => q, eq: () => q,
        single: async () => ({ data: { id: "job-1", status: "done", result: { rows: st.pull }, error: null }, error: null }),
      };
      return q;
    }
    if (table === "activity_events") return { insert: async (row: any) => { st.events.push(row); return { error: null }; } };
    // price_list
    let mode: "read" | "delete" | null = null;
    const del = { items: [] as string[], eq: [] as Array<[string, any]> };
    const q: any = {
      upsert: async () => ({ error: null }),
      select: () => { mode = "read"; return q; },
      delete: () => { mode = "delete"; return q; },
      in: (_c: string, items: string[]) => { del.items = items; return q; },
      order: () => q,
      eq: (c: string, v: any) => {
        if (mode === "delete") { del.eq.push([c, v]); st.deletes.push(del); return Promise.resolve({ error: null }); }
        return q;
      },
      range: async (f: number, t: number) => {
        st.ranges.push([f, t]);
        return { data: st.existing.slice(f, t + 1), error: null, count: st.existing.length };
      },
    };
    return q;
  };
  return { supabaseAdmin: { from } };
});

import { applyPricerSync } from "../p21.server";

const items = (n: number) => Array.from({ length: n }, (_, i) => `ITEM-${String(i).padStart(5, "0")}`);
const pullOf = (list: string[]) => list.map((it) => ({ "Item #": it, "List Price": "1.00" }));

beforeEach(() => {
  st.pull = []; st.existing = []; st.deletes = []; st.ranges = []; st.famArgs = []; st.events = [];
  st.famResult = { updated: 0, failed: 0, changed: 0 };
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0 as any; }) as any);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("applyPricerSync cleanup guard", () => {
  it("empty pull deletes nothing and sets cleanup_skipped", async () => {
    st.existing = items(15026).map((item, i) => ({ id: String(i), item }));
    const res = await applyPricerSync();
    expect(st.deletes).toEqual([]);
    expect(res.removed).toBe(0);
    expect(res.cleanup_skipped).toMatch(/0 usable items/);
  });

  it("pull missing 20% of existing items deletes nothing", async () => {
    const all = items(1000);
    st.existing = all.map((item, i) => ({ id: String(i), item }));
    st.pull = pullOf(all.slice(0, 800));
    const res = await applyPricerSync();
    expect(st.deletes).toEqual([]);
    expect(res.removed).toBe(0);
    expect(res.cleanup_skipped).toMatch(/200 of 1000 .*>10%/);
  });

  it("pull missing 5% deletes exactly those items in 500-row batches scoped to p21_sql", async () => {
    const all = items(12000);
    st.existing = all.map((item, i) => ({ id: String(i), item }));
    st.pull = pullOf(all.slice(0, 11400)); // 600 missing = 5%
    const res = await applyPricerSync();
    expect(res.cleanup_skipped).toBeUndefined();
    expect(res.removed).toBe(600);
    expect(st.deletes.map((d) => d.items.length)).toEqual([500, 100]);
    expect(st.deletes.flatMap((d) => d.items)).toEqual(all.slice(11400));
    expect(st.deletes.every((d) => d.eq.length === 1 && d.eq[0][0] === "source" && d.eq[0][1] === "p21_sql")).toBe(true);
  });

  it("reads 1,500 existing rows in full through the shared pager (2 pages)", async () => {
    const all = items(1500);
    st.existing = all.map((item, i) => ({ id: String(i), item }));
    st.pull = pullOf(all.slice(0, 1400)); // 100 missing ≈ 6.7%, all beyond row 1,000
    const res = await applyPricerSync();
    expect(st.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(res.removed).toBe(100);
    expect(st.deletes.flatMap((d) => d.items)).toEqual(all.slice(1400));
  });

  it("boundary: exactly 10% removed (1,502 of 15,026) deletes", async () => {
    const all = items(15026);
    st.existing = all.map((item, i) => ({ id: String(i), item }));
    st.pull = pullOf(all.slice(0, 15026 - 1502));
    const res = await applyPricerSync();
    expect(res.cleanup_skipped).toBeUndefined();
    expect(res.removed).toBe(1502);
  });

  it("boundary: 1,503 of 15,026 removed skips cleanup", async () => {
    const all = items(15026);
    st.existing = all.map((item, i) => ({ id: String(i), item }));
    st.pull = pullOf(all.slice(0, 15026 - 1503));
    const res = await applyPricerSync();
    expect(st.deletes).toEqual([]);
    expect(res.cleanup_skipped).toMatch(/1503 of 15026/);
  });
});

describe("applyPricerSync family relabel wiring", () => {
  it("passes no force and records families_skipped / cleanup_skipped in pricer.synced metadata", async () => {
    st.existing = items(100).map((item, i) => ({ id: String(i), item }));
    st.famResult = { updated: 0, failed: 0, changed: 900, skipped: "family relabel would change 900 of 1000 rows (cap 500); nothing written" };
    const res = await applyPricerSync();
    expect(st.famArgs).toEqual([[]]);
    expect(res.families_skipped).toMatch(/900 of 1000/);
    expect(res.cleanup_skipped).toMatch(/0 usable items/);
    const ev = st.events.find((e) => e.event_type === "pricer.synced")!;
    expect(ev.metadata.families_skipped).toMatch(/900 of 1000/);
    expect(ev.metadata.cleanup_skipped).toMatch(/0 usable items/);
  });
});
