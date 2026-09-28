import { describe, expect, it } from "vitest";
import { buildSalesReportSql } from "../sales-annualized-template";
import { sanitizeBridgeSql } from "../p21.server";
import { parseKeepLevel } from "../sales-reports.server";

describe("buildSalesReportSql", () => {
  for (const m of [1, 5, 8, 12]) {
    it(`substitutes month ${m}`, () => {
      const sql = buildSalesReportSql({ repCode: "4157", year: 2026, month: m });
      expect(sql).toContain(`f.SalesMonth BETWEEN 1 AND ${m} `);
      expect(sql).toContain(`f.SalesMonth = ${m} `);
      expect(sql).toContain(`b.SalesYTD * 12.0 / ${m} AS Annualized`);
      expect(sql).toContain("f.SalesYear BETWEEN 2022 AND 2026");
      expect(sql).toContain("m.SalesRepID = '4157'");
      expect(sql).not.toMatch(/\{py\}|\{pm\}|__REPCODE__/);
      expect(sql).toMatch(/P21_Analytics_PLAY\.Sales\.vwFactShipToSales/);
      expect(sql).not.toMatch(/oe_hdr_salesrep/);
      const clean = sanitizeBridgeSql(sql);
      expect(clean).not.toMatch(/;/);
      expect(clean).not.toMatch(/--|\/\*/);
      expect(clean).toBe(sql.trim());
    });
  }
  it("escapes quotes in rep code", () => {
    expect(buildSalesReportSql({ repCode: "a'b", year: 2026, month: 5 })).toContain("m.SalesRepID = 'a''b'");
  });
  it("rejects bad input", () => {
    expect(() => buildSalesReportSql({ repCode: "1", year: 2019, month: 5 })).toThrow();
    expect(() => buildSalesReportSql({ repCode: "1", year: 2101, month: 5 })).toThrow();
    expect(() => buildSalesReportSql({ repCode: "1", year: 2026, month: 0 })).toThrow();
    expect(() => buildSalesReportSql({ repCode: "1", year: 2026, month: 13 })).toThrow();
    expect(() => buildSalesReportSql({ repCode: "1", year: 2026.5, month: 5 })).toThrow();
    expect(() => buildSalesReportSql({ repCode: "1", year: 2026, month: "5; DROP" as any })).toThrow();
    expect(() => buildSalesReportSql({ repCode: "  ", year: 2026, month: 5 })).toThrow();
  });
});

describe("parseKeepLevel", () => {
  it("code", () => {
    expect(parseKeepLevel("ISG", "L2", 200000)).toEqual({ keep_lvl_code: "ISG", keep_lvl_threshold: null, keep_lvl_shortfall: null });
  });
  it("numeric shortfall", () => {
    expect(parseKeepLevel("12500.00", "L3", 100000)).toEqual({ keep_lvl_code: "L3", keep_lvl_threshold: 100000, keep_lvl_shortfall: 12500 });
    expect(parseKeepLevel("0.00", "L4", 25000).keep_lvl_shortfall).toBe(0);
  });
  it("null", () => {
    expect(parseKeepLevel(null, "L1", 450000)).toEqual({ keep_lvl_code: null, keep_lvl_threshold: null, keep_lvl_shortfall: null });
  });
});
