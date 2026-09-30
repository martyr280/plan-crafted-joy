import { describe, expect, it } from "vitest";
import {
  buildSalesReportSql, isLineCounted, attributeRep, keepLevel, includeRow, deriveColumns, EXCLUDED_PRODUCT_GROUPS,
} from "../sales-annualized-template";
import { sanitizeBridgeSql } from "../p21.server";
import { parseKeepLevel, parseReportRowChecked } from "../sales-reports.server";

describe("buildSalesReportSql (2026-09-30 definition)", () => {
  for (const m of [1, 5, 8, 12]) {
    it(`substitutes month ${m}`, () => {
      const sql = buildSalesReportSql({ year: 2026, month: m });
      expect(sql).toContain(`DATEFROMPARTS(2026, ${m}, 1)`);
      expect(sql).toContain(`Mo = ${m} THEN Ep`);
      expect(sql).toContain(`b.SalesYTD * 12.0 / ${m} AS decimal(19,2)) AS [Ann Current]`);
      expect(sql).toContain("Yr = 2025 THEN Ep ELSE 0 END) AS PriorYear");
      expect(sql).not.toMatch(/\{py\}|\{pm\}|__REPCODE__|vwFactShipToSales|WHERE g\.Rep/);
      const clean = sanitizeBridgeSql(sql);
      expect(clean).not.toMatch(/;/);
      expect(clean).not.toMatch(/--|\/\*/);
      expect(clean).toBe(sql.trim());
    });
  }
  it("encodes every exclusion, keeps 9912, drops kit headers, uses MIN order rep", () => {
    const sql = buildSalesReportSql({ year: 2026, month: 8 });
    expect(sql).toContain("il.product_group_id NOT IN ('10', '50', '95', '9908', '9910', '9911')");
    expect(sql).not.toContain("9912");
    expect(sql).toContain("il.product_group_id IS NOT NULL");
    expect(sql).toContain("il.item_id NOT IN ('999999')");
    expect(sql).toContain("c.invoice_line_uid_parent = il.invoice_line_uid");
    expect(sql).toContain("MIN(salesrep_id) AS OrderRep");
    expect(sql).toContain("ISNULL(O.OrderRep, L.InvRep) AS Rep");
    expect(sql).toContain("GROUP BY Rep, CustomerID");
    expect(sql).toMatch(/WHERE b\.Sales2022 <> 0 OR .* OR b\.SalesYTD <> 0/);
  });
  it("one-rep variant filters on the attributed rep and escapes quotes", () => {
    expect(buildSalesReportSql({ repCode: "a'b", year: 2026, month: 5 })).toContain("WHERE g.Rep = 'a''b'");
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

describe("line rules", () => {
  const L = (g: string | null, item = "ABC", kids = false) => isLineCounted({ product_group_id: g, item_id: item, hasComponentLines: kids });
  it("exclusion groups", () => {
    for (const g of EXCLUDED_PRODUCT_GROUPS) expect(L(g)).toBe(false);
    expect(L(null)).toBe(false);
    expect(L("9912")).toBe(true);
    expect(L("200")).toBe(true);
    expect(L("200", "999999")).toBe(false);
  });
  it("kit header with components dropped; component and component-less kit counted", () => {
    expect(L("200", "SUITE1", true)).toBe(false);
    expect(L("200", "SUITE1-PART", false)).toBe(true);
    expect(L("200", "WSBASE24SIL", false)).toBe(true);
  });
  it("MIN order rep, else invoice rep, else none", () => {
    expect(attributeRep(["5614", "4571", "5333"], "1015")).toBe("4571");
    expect(attributeRep([], "1015")).toBe("1015");
    expect(attributeRep([null, ""], "1015")).toBe("1015");
    expect(attributeRep([], null)).toBeNull();
  });
});

describe("row rules", () => {
  it("Keep Lvl = target - YTD for numeric tiers, not floored; codes otherwise", () => {
    expect(keepLevel("N", "L3", 100000, 10773.2)).toEqual({ kind: "number", value: 89226.8, threshold: 100000 });
    expect(keepLevel(null, "L1", 450000, 500000)).toEqual({ kind: "number", value: -50000, threshold: 450000 });
    expect(keepLevel("ISG", "L1", 450000, 1)).toEqual({ kind: "code", code: "ISG" });
    expect(keepLevel("N", "L5", 0, 1000)).toEqual({ kind: "code", code: "L5" });
    expect(keepLevel("N", "MML1", null, 1000)).toEqual({ kind: "code", code: "MML1" });
    expect(keepLevel("N", null, null, 1000)).toBeNull();
  });
  it("Pct blank on zero prior year; Ann and Total Value", () => {
    const base = { y2022: 1, y2023: 2, y2024: 3, y2025: 0, ytd: 800, priorYear: 0 };
    expect(deriveColumns(base, 8)).toEqual({ total_value: 806, ann_current: 1200, pct: null });
    expect(deriveColumns({ ...base, y2025: 1000, priorYear: 1000 }, 8).pct).toBe(0.2);
  });
  it("row inclusion: no zero-everything rows", () => {
    expect(includeRow({ y2022: 0, y2023: 0, y2024: 0, y2025: 0, ytd: 0 })).toBe(false);
    expect(includeRow({ y2022: 5, y2023: 0, y2024: 0, y2025: 0, ytd: 0 })).toBe(true);
    expect(includeRow({ y2022: 0, y2023: 0, y2024: 0, y2025: 0, ytd: -41.85 })).toBe(true);
  });
  it("parser takes rep from the row and cross-checks SQL-derived columns", () => {
    const raw = {
      Rep: "5333", RepName: "TRAVIS SPEIER", "Cust Code": "15478", Price: "L1", BG: "N", "Customer Name": "EVERYTHING2GO.COM LLC",
      "Total Value": 2458537.42, "Year 2022": 263797.08, "Year 2023": 505599.56, "Year 2024": 673245.89, "Year 2025": 567334.10,
      "Year Current": 448560.79, "Ann Current": 672841.19, Pct: 0.186, "Month Sales": 69946.72, "Month Profit": 32201.36,
      "Keep Lvl": "1439.21", PriorYear: 567334.10, BuyingGroup: null, PriceLevel: "L1", TargetSales: 450000,
    };
    const p = parseReportRowChecked(raw, { rep_code: "", rep_name: null, rep_email: null }, 8)!;
    expect(p.row.rep_code).toBe("5333");
    expect(p.row.keep_lvl_shortfall).toBe(1439.21);
    expect(p.parityMismatch).toMatch(/total_value/); // deliberately wrong total above
    const ok = parseReportRowChecked({ ...raw, "Total Value": 2458537.42 - 0 + (263797.08 + 505599.56 + 673245.89 + 567334.10 + 448560.79 - 2458537.42) }, { rep_code: "", rep_name: null, rep_email: null }, 8)!;
    expect(ok.parityMismatch).toBeNull();
  });
});

describe("parseKeepLevel", () => {
  it("code", () => {
    expect(parseKeepLevel("ISG", "L2", 200000)).toEqual({ keep_lvl_code: "ISG", keep_lvl_threshold: null, keep_lvl_shortfall: null });
  });
  it("numeric shortfall, negative allowed", () => {
    expect(parseKeepLevel("12500.00", "L3", 100000)).toEqual({ keep_lvl_code: "L3", keep_lvl_threshold: 100000, keep_lvl_shortfall: 12500 });
    expect(parseKeepLevel("-95075.26", "L3", 100000).keep_lvl_shortfall).toBe(-95075.26);
  });
  it("null", () => {
    expect(parseKeepLevel(null, "L1", 450000)).toEqual({ keep_lvl_code: null, keep_lvl_threshold: null, keep_lvl_shortfall: null });
  });
});
