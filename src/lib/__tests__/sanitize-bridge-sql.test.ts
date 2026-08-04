import { describe, expect, it } from "vitest";
import { sanitizeBridgeSql } from "../p21.server";
import { SALES_ANNUALIZED_SQL } from "../sales-annualized-template";

describe("sanitizeBridgeSql", () => {
  it("removes line comments, block comments and trailing semicolons", () => {
    const out = sanitizeBridgeSql("-- header; note\n/* block; note */\nSELECT 1;\n");
    expect(out).not.toMatch(/;/);
    expect(out).not.toMatch(/--/);
    expect(out.trim().startsWith("SELECT")).toBe(true);
  });

  it("preserves semicolons and -- inside string literals and brackets", () => {
    const sql = "SELECT 'a;b--c' AS [x;y] -- drop me";
    expect(sanitizeBridgeSql(sql)).toBe("SELECT 'a;b--c' AS [x;y]");
  });

  it("handles escaped quotes without eating the rest of the query", () => {
    expect(sanitizeBridgeSql("SELECT 'it''s' AS a; -- x")).toBe("SELECT 'it''s' AS a");
  });

  it("leaves the sales annualized template with zero semicolons and no comments", () => {
    const out = sanitizeBridgeSql(SALES_ANNUALIZED_SQL);
    expect(out).not.toMatch(/;/);
    expect(out).not.toMatch(/--/);
    expect(out).toMatch(/^WITH ctx AS/);
    expect(out).toMatch(/ORDER BY agg\.m_sales DESC/);
  });
});
