import { describe, it, expect } from "vitest";
import { fetchAllRows, type PagedQuery } from "../supabase-fetch-all";

type R = { id: number };

function fake(opts: { total: number; serve?: number; countFn?: (call: number) => number | null; errorOnCall?: number; delay?: (from: number) => number }) {
  const all: R[] = Array.from({ length: opts.total }, (_, i) => ({ id: i + 1 }));
  const calls: Array<[number, number]> = [];
  const orders: Array<[string, boolean | undefined]> = [];
  let n = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const build = (): PagedQuery<R> => {
    const q: PagedQuery<R> = {
      order(col, o) { orders.push([col, o?.ascending]); return q; },
      async range(from, to) {
        calls.push([from, to]);
        const call = ++n;
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, opts.delay ? opts.delay(from) : 0));
        inFlight--;
        if (opts.errorOnCall === call) return { data: null, error: { message: "boom" }, count: null };
        const served = all.slice(0, opts.serve ?? opts.total);
        const count = opts.countFn ? opts.countFn(call) : opts.total;
        return { data: served.slice(from, to + 1), error: null, count };
      },
    };
    return q;
  };
  return { build, calls, orders, get maxInFlight() { return maxInFlight; } };
}

describe("shared fetchAllRows pager", () => {
  it("returns all 2,500 rows across 3 pages in order", async () => {
    const f = fake({ total: 2500 });
    const rows = await fetchAllRows(f.build);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2500 }, (_, i) => i + 1));
    expect(f.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(f.orders.every(([c]) => c === "id")).toBe(true);
  });

  it("returns all 47,040 rows with concurrency 4, page order preserved", async () => {
    // Later pages resolve faster to prove reassembly is by page index.
    const f = fake({ total: 47040, delay: (from) => (from > 20000 ? 0 : 3) });
    const rows = await fetchAllRows(f.build, { concurrency: 4, orderBy: [{ column: "forecast_date" }, { column: "id" }] });
    expect(rows.length).toBe(47040);
    expect(rows.every((r, i) => r.id === i + 1)).toBe(true);
    expect(f.calls.length).toBe(48);
    expect(f.maxInFlight).toBe(4);
  });

  it("applies orderBy columns in sequence with directions", async () => {
    const f = fake({ total: 5 });
    await fetchAllRows(f.build, { orderBy: [{ column: "snapshot_at", ascending: false }, { column: "id" }] });
    expect(f.orders).toEqual([["snapshot_at", false], ["id", true]]);
  });

  it("throws when count is null", async () => {
    const f = fake({ total: 10, countFn: () => null });
    await expect(fetchAllRows(f.build)).rejects.toThrow(/no exact row count/);
  });

  it("throws when fetched length !== count", async () => {
    const f = fake({ total: 1550, serve: 1000 });
    await expect(fetchAllRows(f.build, { label: "x" })).rejects.toThrow(/x: fetched 1000 of 1550 rows/);
  });

  it("throws when the count changes between pages", async () => {
    const f = fake({ total: 2500, countFn: (c) => (c === 1 ? 2500 : 2501) });
    await expect(fetchAllRows(f.build)).rejects.toThrow(/row count changed during paging/);
  });

  it("throws when orderBy does not end with a unique column", async () => {
    const f = fake({ total: 10 });
    await expect(fetchAllRows(f.build, { orderBy: [{ column: "route_id" }, { column: "forecast_date" }, { column: "made_on" }] }))
      .rejects.toThrow(/orderBy must end with a unique column/);
    expect(f.calls.length).toBe(0);
  });

  it("throws on a page error", async () => {
    const f = fake({ total: 2500, errorOnCall: 2 });
    await expect(fetchAllRows(f.build)).rejects.toThrow(/page starting at 1000 failed: boom/);
  });

  it("throws at the max-pages guard instead of returning a partial set", async () => {
    const f = fake({ total: 60 });
    await expect(fetchAllRows(f.build, { pageSize: 10, maxPages: 5 })).rejects.toThrow(/exceed 5 pages/);
  });

  it("exactly 1,000 rows needs one call; zero rows returns empty", async () => {
    const f = fake({ total: 1000 });
    expect((await fetchAllRows(f.build)).length).toBe(1000);
    expect(f.calls.length).toBe(1);
    expect(await fetchAllRows(fake({ total: 0 }).build)).toEqual([]);
  });
});
