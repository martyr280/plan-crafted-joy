import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fetchFirstRows } from "../supabase-fetch-all";

const TOTAL = 3351;
function mockTable() {
  const calls: Array<{ range: [number, number]; orders: string[] }> = [];
  const build = () => {
    const orders: string[] = [];
    const q: any = {
      order: (c: string, o: any) => { orders.push(`${c}:${o?.ascending === false ? "desc" : "asc"}`); return q; },
      range: async (f: number, t: number) => {
        calls.push({ range: [f, t], orders });
        const end = Math.min(t, TOTAL - 1);
        return { data: Array.from({ length: Math.max(0, end - f + 1) }, (_, i) => ({ id: String(f + i) })), error: null, count: null };
      },
    };
    return q;
  };
  return { calls, build };
}
const ORDER = [{ column: "run_date", ascending: false }, { column: "id" }];

describe("listTruckRuns top-N read", () => {
  it("limit 500 -> one request, range 0..499, ordered run_date desc, id", async () => {
    const t = mockTable();
    const rows = await fetchFirstRows(t.build, 500, { orderBy: ORDER });
    expect(rows).toHaveLength(500);
    expect(t.calls.map((c) => c.range)).toEqual([[0, 499]]);
    expect(t.calls[0].orders).toEqual(["run_date:desc", "id:asc"]);
  });

  it("limit 3000 of 3351 -> stops at 3000 rows without reading the rest", async () => {
    const t = mockTable();
    const rows = await fetchFirstRows(t.build, 3000, { orderBy: ORDER });
    expect(rows).toHaveLength(3000);
    expect(t.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("wiring: filters kept, default 500, run_date desc + id, no full-table pager", () => {
    const src = readFileSync("src/lib/truck-capacity.functions.ts", "utf8");
    const start = src.indexOf("export const listTruckRuns");
    const body = src.slice(start, src.indexOf("const UpsertRun", start));
    expect(body).toContain("fetchFirstRows");
    expect(body).not.toContain("fetchAllRows");
    expect(body).toContain("data.limit ?? 500");
    expect(body).toContain('orderBy: [{ column: "run_date", ascending: false }, { column: "id" }]');
    expect(body).toContain('q = q.eq("route_id", data.routeId)');
    expect(body).toContain('q = q.gte("run_date", data.from)');
    expect(body).toContain('q = q.lte("run_date", data.to)');
  });
});
