import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("listTruckRuns pages through the shared pager", () => {
  const src = readFileSync("src/lib/truck-capacity.functions.ts", "utf8");
  const start = src.indexOf("export const listTruckRuns");
  const body = src.slice(start, src.indexOf("const UpsertRun", start));
  it("count exact, order [run_date desc, id], filters kept, sliced to limit, no .limit", () => {
    expect(body).toContain('import("./supabase-fetch-all")');
    expect(body).toContain('.select("*", { count: "exact" })');
    expect(body).toContain('orderBy: [{ column: "run_date", ascending: false }, { column: "id" }]');
    expect(body).toContain('q = q.eq("route_id", data.routeId)');
    expect(body).toContain('q = q.gte("run_date", data.from)');
    expect(body).toContain('q = q.lte("run_date", data.to)');
    expect(body).toContain("rows.slice(0, data.limit ?? 500)");
    expect(body).not.toMatch(/\.limit\(|\.range\(|\.order\(/);
  });
});
