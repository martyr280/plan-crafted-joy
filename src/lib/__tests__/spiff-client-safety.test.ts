import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pageAll } from "../spiff/page-all";
import { manualIncludePatch } from "../spiff/manual-include";
describe("SPIFF client safety", () => {
  it("client pageAll rejects null exact count", async () => {
    await expect(pageAll(async () => ({ data: [], error: null, count: null }))).rejects.toThrow("no exact row count");
  });
  it("client pageAll returns all 1550 lines over two pages", async () => {
    const rows = Array.from({ length: 1550 }, (_, id) => ({ id }));
    expect(await pageAll(async (from, to) => ({ data: rows.slice(from, to + 1), error: null, count: 1550 }))).toEqual(rows);
  });
  it("UI inclusion sets explicit marker and preserves return_credit and amount", () => {
    const line = { included: false, exclusion_reason: "return_credit", flags: { return_credit: true, oe_line_no: "1" }, spiff_amount: 0 };
    expect(manualIncludePatch(line, { included: true, exclusion_reason: null })).toEqual({ included: true, exclusion_reason: null, flags: { return_credit: true, oe_line_no: "1", manual_include: true } });
    expect(line.spiff_amount).toBe(0);
  });
  it("UI exclusion removes manual_include and always uses manual reason", () => {
    const line = { included: true, exclusion_reason: null, flags: { manual_include: true, return_credit: true } };
    expect(manualIncludePatch(line, { included: false, exclusion_reason: "other" })).toEqual({ included: false, exclusion_reason: "manual", flags: { return_credit: true } });
  });
  it("screen run lines/checks and server run readers are wired to complete pagers", () => {
    const screen = readFileSync("src/routes/_app.spiff.tsx", "utf8");
    const helper = readFileSync("src/lib/spiff/fetch-all.server.ts", "utf8");
    expect(screen).toContain('import { pageAll } from "@/lib/spiff/page-all"');
    expect(screen).toMatch(/pageAll<Line>[\s\S]*?from\("spiff_run_lines"\)[\s\S]*?range\(from, to\)/);
    expect(screen).toMatch(/pageAll<Check>[\s\S]*?from\("spiff_checks"\)[\s\S]*?range\(from, to\)/);
    expect(screen).toContain("patch = manualIncludePatch(line, patch, program.rate)");
    expect(helper).toMatch(/function fetchAllRunLines[\s\S]*?return fetchAllRows<T>/);
    expect(helper).toMatch(/function fetchAllRunChecks[\s\S]*?return fetchAllRows<T>/);
  });
});
