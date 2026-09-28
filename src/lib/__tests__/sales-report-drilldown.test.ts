import { describe, expect, it } from "vitest";
import { buildDrilldown, cardTotal, csvCell, toCsv, DRILLDOWN_KINDS } from "../sales-reports.drilldown";
import { summarizeByRep, type SalesReportRow } from "../sales-reports.shared";

const base = (o: Partial<SalesReportRow>): SalesReportRow => ({
  rep_code: "A", rep_name: "Alice", cust_code: "C", price_level: null, bg: null, customer_name: "X",
  city: null, state: null, total_value: 0, y2022: 0, y2023: 0, y2024: 0, y2025: 0, y_current: 0,
  ann_current: 0, pct: null, month_sales: 0, month_profit: 0, keep_lvl_code: null,
  keep_lvl_threshold: null, keep_lvl_shortfall: null, ...o,
});

const rows: SalesReportRow[] = [
  base({ cust_code: "1", y_current: 1000.1, ann_current: 1800, month_sales: 200.3, month_profit: 50, y2025: 6000, price_level: "L3", keep_lvl_threshold: 5000 }),
  base({ cust_code: "2", y_current: 0.2, month_sales: 0, y2025: 7000 }),
  base({ cust_code: "3", rep_code: "B", rep_name: "Bob", y_current: 333.33, ann_current: 9000, month_sales: -10.7, keep_lvl_threshold: 8000, price_level: "L1" }),
  base({ cust_code: "4", rep_code: "B", rep_name: "Bob", y_current: 0, month_sales: 0, y2025: 4999 }),
  base({ cust_code: "5", rep_code: "B", rep_name: "Bob", y_current: -12.34, ann_current: 10, keep_lvl_code: "ISG", keep_lvl_threshold: 99999 }),
];

describe("sales report drilldown", () => {
  it("drawer total equals card total for all 4 kinds", () => {
    const reps = summarizeByRep(rows);
    for (const k of DRILLDOWN_KINDS) expect(buildDrilldown(rows, k).total).toBe(cardTotal(reps, k));
  });

  it("money drawer rows add up to the card", () => {
    const y = buildDrilldown(rows, "ytd");
    expect(y.rows.reduce((a, r) => a + r.y_current, 0)).toBeCloseTo(y.total, 6);
    const m = buildDrilldown(rows, "month");
    expect(m.rows.reduce((a, r) => a + r.month_sales, 0)).toBeCloseTo(m.total, 6);
  });

  it("at-risk and win-back counts equal summarizeByRep totals", () => {
    const reps = summarizeByRep(rows);
    const risk = reps.reduce((a, r) => a + r.at_risk, 0);
    const win = reps.reduce((a, r) => a + r.win_backs, 0);
    expect(buildDrilldown(rows, "at_risk").count).toBe(risk);
    expect(buildDrilldown(rows, "win_back").count).toBe(win);
    expect(risk).toBe(1);
    expect(win).toBe(1);
  });

  it("gap to target is floored at 0", () => {
    const d = buildDrilldown(rows, "at_risk");
    expect(d.rows[0].gap).toBe(3200);
  });

  it("CSV export escapes commas and quotes", () => {
    expect(csvCell('Smith, "Jr"')).toBe('"Smith, ""Jr"""');
    expect(csvCell(null)).toBe("");
    expect(toCsv(["A", "B"], [["a,b", 1]])).toBe('A,B\r\n"a,b",1\r\n');
  });
});
