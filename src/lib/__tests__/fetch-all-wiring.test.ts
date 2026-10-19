import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Source-text wiring: each fixed call site goes through the shared pager with
// count:"exact", the expected unique orderBy, and no .limit( on the query.
const SITES: Array<{ file: string; label: string; table: string; order: string }> = [
  { file: "src/lib/truck-capacity.functions.ts", label: "getForecastVsActual forecast_log", table: "truck_capacity_forecast_log", order: '[{ column: "forecast_date" }, { column: "id" }], concurrency: 4' },
  { file: "src/lib/truck-capacity.functions.ts", label: "getForecastVsActual runs", table: "truck_capacity_runs", order: '[{ column: "run_date" }, { column: "id" }]' },
  { file: "src/lib/truck-capacity.functions.ts", label: "snapshot readout truck_capacity_p21_demand", table: "truck_capacity_p21_demand", order: '[{ column: "id" }]' },
  { file: "src/lib/truck-capacity.functions.ts", label: "coverage truck_capacity_p21_demand", table: "truck_capacity_p21_demand", order: '[{ column: "id" }]' },
  { file: "src/lib/truck-capacity.functions.ts", label: "scoreboard truck_capacity_runs", table: "truck_capacity_runs", order: '{ column: "run_seq" }, { column: "id" }]' },
  { file: "src/lib/truck-capacity.functions.ts", label: "scoreboard truck_capacity_forecast_log", table: "truck_capacity_forecast_log", order: '{ column: "made_on" }, { column: "id" }]' },
  { file: "src/lib/truck-capacity/board.ts", label: "board truck_capacity_p21_demand", table: "truck_capacity_p21_demand", order: '[{ column: "snapshot_at", ascending: false }, { column: "id" }]' },
  { file: "src/lib/truck-capacity/board.ts", label: "board truck_capacity_runs", table: "truck_capacity_runs", order: '[{ column: "run_date", ascending: false }, { column: "id" }]' },
  { file: "src/lib/pricer.functions.ts", label: "listSkuFamilies price_list", table: "price_list", order: '[{ column: "item_short" }, { column: "id" }]' },
  { file: "src/lib/pricer.functions.ts", label: "listFamilyImages price_list", table: "price_list", order: '[{ column: "id" }]' },
  { file: "src/lib/pricer.functions.ts", label: "listPricerFilters price_list", table: "price_list", order: '[{ column: "id" }]' },
  { file: "src/lib/p21.server.ts", label: "p21_sql cleanup price_list", table: "price_list", order: '[{ column: "id" }]' },
  { file: "src/lib/truck-capacity.server.ts", label: "baseline route runs", table: "truck_capacity_runs", order: '[{ column: "run_date" }, { column: "id" }]' },
  { file: "src/lib/truck-capacity.server.ts", label: "baseline hub runs", table: "truck_capacity_runs", order: '[{ column: "run_date" }, { column: "id" }]' },
  { file: "src/lib/truck-capacity.server.ts", label: "exportCapacityWorkbook runs", table: "truck_capacity_runs", order: '[{ column: "run_date" }, { column: "id" }]' },
  { file: "src/lib/truck-capacity-reps.functions.ts", label: "underfilled truck_capacity_runs", table: "truck_capacity_runs", order: '[{ column: "run_date" }, { column: "id" }]' },
  { file: "src/lib/capacity-alerts.server.ts", label: "capacity alerts truck_capacity_runs", table: "truck_capacity_runs", order: '[{ column: "run_date" }, { column: "id" }]' },
];

function block(file: string, label: string): string {
  const src = readFileSync(file, "utf8");
  const end = src.indexOf(`label: "${label}"`);
  expect(end, `${label} not found in ${file}`).toBeGreaterThan(0);
  const start = src.lastIndexOf("fetchAllRows<", end);
  const lineEnd = src.indexOf("\n", end);
  return src.slice(start, lineEnd);
}

describe("fixed call sites use the shared pager", () => {
  for (const s of SITES) {
    it(`${s.file} — ${s.label}`, () => {
      const b = block(s.file, s.label);
      expect(b).toContain(`from("${s.table}")`);
      expect(b).toContain('{ count: "exact" }');
      expect(b).toContain(`orderBy: ${s.order}`);
      expect(b).not.toMatch(/\.limit\(/);
      expect(b).not.toMatch(/\.range\(/);
      expect(b).not.toMatch(/\.order\(/);
      const src = readFileSync(s.file, "utf8");
      expect(src).toMatch(/import\(["']\.\.?\/supabase-fetch-all["']\)/);
    });
  }
  it("baseline hub runs keep the inner-join hub filter", () => {
    const b = block("src/lib/truck-capacity.server.ts", "baseline hub runs");
    expect(b).toContain("truck_capacity_routes!inner(hub)");
    expect(b).toContain('.eq("truck_capacity_routes.hub", route.hub)');
  });
  it("listSkuFamilies keeps the optional search filter", () => {
    const b = block("src/lib/pricer.functions.ts", "listSkuFamilies price_list");
    expect(b).toContain("q = q.or(`item.ilike.%${esc}%,item_short.ilike.%${esc}%,description.ilike.%${esc}%`)");
  });
  it("only the shared pager module implements paging; serve.ts does not import it", () => {
    expect(readFileSync("src/lib/spiff/fetch-all.server.ts", "utf8")).toContain('from "../supabase-fetch-all"');
    expect(readFileSync("src/lib/truck-capacity/serve.ts", "utf8")).not.toContain("supabase-fetch-all");
  });
});

// Mocked supabaseAdmin: the SPIFF helpers still run through the shared pager.
const calls: any[] = [];
vi.mock("@/integrations/supabase/client.server", () => {
  const rows = Array.from({ length: 1550 }, (_, i) => ({ id: i + 1 }));
  const make = (table: string) => {
    const rec: any = { table, select: null, eq: [], order: [], range: [] };
    calls.push(rec);
    const q: any = {
      select(c: string, o: any) { rec.select = [c, o]; return q; },
      eq(c: string, v: any) { rec.eq.push([c, v]); return q; },
      in() { return q; },
      order(c: string, o: any) { rec.order.push([c, o?.ascending]); return q; },
      range(f: number, t: number) { rec.range.push([f, t]); return Promise.resolve({ data: rows.slice(f, t + 1), error: null, count: 1550 }); },
    };
    return q;
  };
  return { supabaseAdmin: { from: make } };
});

describe("SPIFF helpers via shared pager", () => {
  it("fetchAllRunLines returns 1,550 rows, order id, count exact", async () => {
    calls.length = 0;
    const { fetchAllRunLines } = await import("../spiff/fetch-all.server");
    const got = await fetchAllRunLines("run-1", "included");
    expect(got.length).toBe(1550);
    expect(calls.every((c) => c.table === "spiff_run_lines" && c.select[0] === "id, included" && c.select[1].count === "exact")).toBe(true);
    expect(calls.flatMap((c) => c.order)).toEqual([["id", true], ["id", true]]);
    expect(calls.flatMap((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
  });
  it("fetchAllRunChecks returns 1,550 rows through the same pager", async () => {
    calls.length = 0;
    const { fetchAllRunChecks } = await import("../spiff/fetch-all.server");
    expect((await fetchAllRunChecks("run-1", "*")).length).toBe(1550);
    expect(calls.every((c) => c.table === "spiff_checks" && c.select[1].count === "exact")).toBe(true);
  });
});
