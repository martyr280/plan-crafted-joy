import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({
  rows: [] as Array<Record<string, any>>,
  updates: [] as Array<{ id: string; item_short: string }>,
  failIds: new Set<string>(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q: any = {
        select: () => q,
        order: () => q,
        range: async (f: number, t: number) => ({ data: st.rows.slice(f, t + 1), error: null, count: st.rows.length }),
        update: (patch: { item_short: string }) => ({
          eq: async (_c: string, id: string) => {
            if (st.failIds.has(id)) return { error: { message: "boom" } };
            st.updates.push({ id, item_short: patch.item_short });
            return { error: null };
          },
        }),
      };
      return q;
    },
  },
}));

import { computeFamilyLabels, recomputeFamilies, type FamilyRow } from "../pricer.server";

const row = (id: string, item: string, list: number, extra: Partial<FamilyRow> = {}): FamilyRow => ({
  id, item, mfg: "M", category: "C", list_price: list, price_l1: list, price_l2: list, price_l3: list, price_l4: list, price_l5: list, ...extra,
});

beforeEach(() => { st.rows = []; st.updates = []; st.failIds = new Set(); vi.spyOn(console, "warn").mockImplementation(() => {}); });

describe("computeFamilyLabels", () => {
  it("(a) WSXN0410WHTSIL and WSXN0080CGYSIL with identical prices are NOT grouped", () => {
    const m = computeFamilyLabels([row("1", "WSXN0410WHTSIL", 10), row("2", "WSXN0080CGYSIL", 10)]);
    expect(m.get("1")).toBe("WSXN0410WHTSIL");
    expect(m.get("2")).toBe("WSXN0080CGYSIL");
  });

  it("(b) PL102APN + PL102CGY with identical prices share 'PL102'", () => {
    const m = computeFamilyLabels([row("1", "PL102APN", 5), row("2", "PL102CGY", 5)]);
    expect(m.get("1")).toBe("PL102");
    expect(m.get("2")).toBe("PL102");
  });

  it("(c) colliding prefix 'ABCD1' from two price groups -> both fall back; no label spans >1 tuple", () => {
    const rows = [row("1", "ABCD1X", 1), row("2", "ABCD1Y", 1), row("3", "ABCD1Z", 2), row("4", "ABCD1W", 2)];
    const m = computeFamilyLabels(rows);
    for (const r of rows) expect(m.get(r.id)).toBe(r.item);
    const tuples = new Map<string, Set<number>>();
    for (const r of rows) {
      const l = m.get(r.id)!;
      tuples.set(l, (tuples.get(l) ?? new Set()).add(r.list_price!));
    }
    expect([...tuples.values()].filter((s) => s.size > 1)).toHaveLength(0);
  });

  it("(c2) a singleton whose own item equals another group's prefix forces that group back", () => {
    const m = computeFamilyLabels([row("1", "PL102APN", 5), row("2", "PL102CGY", 5), row("3", "PL102", 9)]);
    expect([m.get("1"), m.get("2"), m.get("3")]).toEqual(["PL102APN", "PL102CGY", "PL102"]);
  });

  it("(d) prefix shorter than 4 or under 60% of the shortest item -> own items", () => {
    const short = computeFamilyLabels([row("1", "ABC1", 3), row("2", "ABC2", 3)]);
    expect([short.get("1"), short.get("2")]).toEqual(["ABC1", "ABC2"]);
    const thin = computeFamilyLabels([row("3", "ABCDE12345X", 4), row("4", "ABCDE99999Y", 4)]);
    expect([thin.get("3"), thin.get("4")]).toEqual(["ABCDE12345X", "ABCDE99999Y"]);
  });
});

describe("recomputeFamilies writes", () => {
  const thousandWith600Changes = () =>
    Array.from({ length: 1000 }, (_, i) => ({ ...row(`id-${i}`, `SKU${i}`, i), item_short: i < 600 ? null : `SKU${i}` }));

  it("(e) 600 changes of 1,000 rows -> nothing written, skipped set, updated 0", async () => {
    st.rows = thousandWith600Changes();
    const res = await recomputeFamilies();
    expect(st.updates).toHaveLength(0);
    expect(res.updated).toBe(0);
    expect(res.changed).toBe(600);
    expect(res.skipped).toMatch(/600 of 1000/);
  });

  it("(e) same with force:true -> written", async () => {
    st.rows = thousandWith600Changes();
    const res = await recomputeFamilies({ force: true });
    expect(res.skipped).toBeUndefined();
    expect(res.updated).toBe(600);
    expect(st.updates).toHaveLength(600);
  });

  it("(f) 3 of 10 updates error -> 7 counted, 3 failed, throws after the loop", async () => {
    st.rows = Array.from({ length: 10 }, (_, i) => ({ ...row(`id-${i}`, `SKU${i}`, i), item_short: null }));
    st.failIds = new Set(["id-1", "id-4", "id-8"]);
    await expect(recomputeFamilies()).rejects.toThrow("3 of 10 updates failed (7 succeeded)");
    expect(st.updates).toHaveLength(7);
  });
});
