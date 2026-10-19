import { describe, expect, it } from "vitest";
import { fetchAllRows, type PagedQuery } from "../spiff/fetch-all.server";

type R = { id: number };

function fake(opts: { total: number; count?: number; serve?: number; errorOnCall?: number }) {
  const all: R[] = Array.from({ length: opts.total }, (_, i) => ({ id: i + 1 })).reverse();
  const calls: Array<[number, number]> = [];
  const orders: string[] = [];
  let n = 0;
  const build = (): PagedQuery<R> => {
    const q: PagedQuery<R> = {
      order(col) {
        orders.push(col);
        return q;
      },
      range(from, to) {
        calls.push([from, to]);
        n++;
        if (opts.errorOnCall === n) return Promise.resolve({ data: null, error: { message: "boom" }, count: null });
        const sorted = [...all].sort((a, b) => a.id - b.id).slice(0, opts.serve ?? opts.total);
        return Promise.resolve({ data: sorted.slice(from, to + 1), error: null, count: opts.count ?? opts.total });
      },
    };
    return q;
  };
  return { build, calls, orders };
}

describe("spiff fetchAllRows", () => {
  it("returns all 2,345 rows in id order over 3 range calls", async () => {
    const f = fake({ total: 2345 });
    const rows = await fetchAllRows(f.build, { label: "t" });
    expect(rows.length).toBe(2345);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 2345 }, (_, i) => i + 1));
    expect(f.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(f.orders.every((o) => o === "id")).toBe(true);
  });

  it("throws when count says 1,550 but only 1,000 rows come back", async () => {
    const f = fake({ total: 1550, serve: 1000 });
    await expect(fetchAllRows(f.build, { label: "spiff_run_lines" })).rejects.toThrow(
      /spiff_run_lines: fetched 1000 of 1550 rows/,
    );
  });

  it("throws on a page error", async () => {
    const f = fake({ total: 2345, errorOnCall: 2 });
    await expect(fetchAllRows(f.build, { label: "t" })).rejects.toThrow(/boom/);
  });
});
