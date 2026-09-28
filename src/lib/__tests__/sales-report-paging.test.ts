import { describe, expect, it } from "vitest";
import { fetchAllRows } from "../supabase-fetch-all";

type R = { id: string; month_sales: number };
const rows: R[] = Array.from({ length: 2580 }, (_, i) => ({ id: `id-${String(i).padStart(5, "0")}`, month_sales: i < 325 ? 1000 - i : 0 }));

// Fake source: ties are returned in a different arbitrary order on every call,
// mimicking Postgres with no stable ordering among equal keys.
function source(tiebreak: boolean) {
  let call = 0;
  return (from: number, to: number) => {
    call++;
    const shuffled = [...rows].sort((a, b) => {
      const c = b.month_sales - a.month_sales;
      if (c !== 0) return c;
      if (tiebreak) return a.id.localeCompare(b.id);
      return ((a.id.charCodeAt(7) * call) % 7) - ((b.id.charCodeAt(7) * call) % 7) || (call % 2 ? 1 : -1) * a.id.localeCompare(b.id);
    });
    return Promise.resolve({ data: shuffled.slice(from, to + 1), error: null });
  };
}

describe("sales_report_rows paging", () => {
  it("returns every row exactly once with the id tiebreaker", async () => {
    const got = await fetchAllRows<R>(source(true));
    expect(got.length).toBe(2580);
    expect(new Set(got.map((r) => r.id)).size).toBe(2580);
  });
  it("without a tiebreaker the unstable source duplicates rows (guard would trip)", async () => {
    const got = await fetchAllRows<R>(source(false));
    expect(new Set(got.map((r) => r.id)).size).toBeLessThan(got.length);
  });
});
