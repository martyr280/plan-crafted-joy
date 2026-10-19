import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fetchAllRows, type PagedQuery } from "../supabase-fetch-all";

type R = { id: string; month_sales: number };
const rows: R[] = Array.from({ length: 2580 }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}`, month_sales: i < 325 ? 1000 - i : 0 }));

// Fake source that honours the orders the pager applies (month_sales desc, id asc).
function build(): PagedQuery<R> {
  const orders: Array<[string, boolean]> = [];
  const q: PagedQuery<R> = {
    order(c, o) { orders.push([c, o?.ascending ?? true]); return q; },
    range(from, to) {
      const sorted = [...rows].sort((a, b) => {
        for (const [c, asc] of orders) {
          const av = (a as any)[c], bv = (b as any)[c];
          if (av !== bv) return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      return Promise.resolve({ data: sorted.slice(from, to + 1), error: null, count: rows.length });
    },
  };
  return q;
}

describe("sales_report_rows paging", () => {
  it("returns every row exactly once with the id tiebreaker", async () => {
    const got = await fetchAllRows<R>(build, { orderBy: [{ column: "month_sales", ascending: false }, { column: "id" }] });
    expect(got.length).toBe(2580);
    expect(new Set(got.map((r) => r.id)).size).toBe(2580);
  });
  it("an orderBy without the id tiebreaker is rejected", async () => {
    await expect(fetchAllRows<R>(build, { orderBy: [{ column: "month_sales", ascending: false }] })).rejects.toThrow(/unique column/);
  });
  it("sales-reports.server uses the shared pager with count exact and id tail", () => {
    const src = readFileSync("src/lib/sales-reports.server.ts", "utf8");
    expect(src).toMatch(/from\("sales_report_rows"\)\.select\("\*", \{ count: "exact" \}\)/);
    expect(src).toContain('orderBy: [{ column: "month_sales", ascending: false }, { column: "id", ascending: true }]');
  });
});
