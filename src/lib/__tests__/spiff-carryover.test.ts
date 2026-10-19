import { describe, expect, it } from "vitest";
import { applyCarryover, type CarryoverLine } from "../spiff/carryover";
import { lineKey } from "../spiff/line-key";

const base: CarryoverLine = {
  customer_id: "C1", order_no: "123", item_id: "CHAIR", invoice_date: "2026-09-01",
  qty_ordered: 2, extended_price: 100, included: true, exclusion_reason: null,
  writing_rep: "Kim", rep_parse_confidence: "parsed", spiff_amount: 5, flags: { oe_line_no: "1" },
};
describe("SPIFF carry-over", () => {
  it("carries manual exclusion without changing amount", () => {
    const result = applyCarryover([{ ...base, included: false, exclusion_reason: "manual" }], [base]);
    expect(result.lines[0]).toMatchObject({ included: false, exclusion_reason: "manual", spiff_amount: 5 });
    expect(result.carried.manual_exclude).toBe(1);
    expect(result.edits.map((e) => e.field)).toEqual(["included", "exclusion_reason"]);
  });
  it("carries re-included credit preserving fresh flags and amount", () => {
    const credit = { ...base, qty_ordered: -2, extended_price: -100, flags: { oe_line_no: "1", return_credit: true } };
    const fresh = { ...credit, included: false, exclusion_reason: "return_credit", spiff_amount: 0 };
    const result = applyCarryover([{ ...credit, flags: { ...credit.flags, manual_include: true } }], [fresh]);
    expect(result.lines[0]).toEqual({ ...fresh, included: true, exclusion_reason: null, flags: { ...fresh.flags, manual_include: true } });
    expect(result.carried.re_include).toBe(1);
  });
  it("old included + fresh excluded by rule + no marker stays excluded", () => {
    const fresh = { ...base, included: false, exclusion_reason: "out_of_scope", spiff_amount: 0 };
    const result = applyCarryover([base], [fresh]);
    expect(result.lines).toEqual([fresh]);
    expect(result.carried.re_include).toBe(0);
    expect(result.edits).toEqual([]);
  });
  it("flags.manual_include carries re-include", () => {
    const fresh = { ...base, included: false, exclusion_reason: "out_of_scope", spiff_amount: 0 };
    const result = applyCarryover([{ ...base, flags: { oe_line_no: "1", manual_include: true } }], [fresh]);
    expect(result.lines[0]).toMatchObject({ included: true, flags: { oe_line_no: "1", manual_include: true }, spiff_amount: 0 });
    expect(result.carried.re_include).toBe(1);
  });
  const historyRow = { id: "edit-1", line_id: "old-1", source: "app", field: "included", new_value: "true", changed_at: "2026-10-19T12:00:00Z" };
  it("app edit-history row included->true carries re-include", () => {
    const result = applyCarryover([{ ...base, id: "old-1" }], [{ ...base, included: false, exclusion_reason: "out_of_scope" }], [historyRow]);
    expect(result.carried.re_include).toBe(1);
    expect(result.lines[0].flags).toMatchObject({ manual_include: true });
  });
  it("server-source edit row does NOT count as a marker", () => {
    const fresh = { ...base, included: false, exclusion_reason: "out_of_scope" };
    const result = applyCarryover([{ ...base, id: "old-1" }], [fresh], [{ ...historyRow, source: "server" }]);
    expect(result.carried.re_include).toBe(0);
    expect(result.lines).toEqual([fresh]);
    expect(result.edits).toEqual([]);
  });
  it("latest app included edit false supersedes an earlier true", () => {
    const result = applyCarryover([{ ...base, id: "old-1" }], [{ ...base, included: false }], [
      { ...historyRow, id: "edit-2", new_value: "false", changed_at: "2026-10-19T13:00:00Z" }, historyRow,
    ]);
    expect(result.carried.re_include).toBe(0);
  });
  it("unmatched included $0 line without marker is NOT reported unmatched", () => {
    const result = applyCarryover([{ ...base, spiff_amount: 0, flags: { oe_line_no: "1", return_credit: true } }], [{ ...base, extended_price: 101 }]);
    expect(result.unmatched).toEqual([]);
    expect(result.snapshot_overrides).toBe(0);
  });
  it("identical legacy duplicate override payloads apply to both fresh lines", () => {
    const old = { ...base, flags: {}, included: false, exclusion_reason: "manual", writing_rep: "Manual", rep_parse_confidence: "manual" };
    const result = applyCarryover([old, old], [base, { ...base, flags: { oe_line_no: "2" } }]);
    expect(result.lines.map((line) => [line.included, line.writing_rep])).toEqual([[false, "Manual"], [false, "Manual"]]);
    expect(result.carried).toEqual({ manual_exclude: 2, re_include: 0, rep: 2 });
    expect(result.unmatched).toEqual([]);
  });
  it("carries manual rep override", () => {
    const result = applyCarryover([{ ...base, writing_rep: "Marty", rep_parse_confidence: "manual" }], [base]);
    expect(result.lines[0]).toMatchObject({ writing_rep: "Marty", rep_parse_confidence: "manual" });
    expect(result.carried.rep).toBe(1);
  });
  it("matches duplicate keys by ordinal using identical stable sorting", () => {
    const old = [{ ...base, unit_price: 20, writing_rep: "Second", rep_parse_confidence: "manual" }, { ...base, unit_price: 10, included: false, exclusion_reason: "manual" }];
    const fresh = [{ ...base, unit_price: 10 }, { ...base, unit_price: 20 }];
    const result = applyCarryover(old, fresh);
    expect(result.lines[0].included).toBe(false);
    expect(result.lines[1].writing_rep).toBe("Second");
  });
  it("reports a changed price unmatched and applies nothing", () => {
    const fresh = { ...base, extended_price: 101 };
    const result = applyCarryover([{ ...base, included: false, exclusion_reason: "manual" }], [fresh]);
    expect(result.lines).toEqual([fresh]);
    expect(result.unmatched).toEqual([{ line_key: lineKey(base), customer_id: "C1", order_no: "123", item_id: "CHAIR", override: "manual_exclude" }]);
    expect(result.carried.manual_exclude).toBe(0);
  });
  it("leaves lines without overrides untouched and does not mutate inputs", () => {
    const old = { ...base, included: false, exclusion_reason: "out_of_scope" };
    const fresh = { ...old };
    const result = applyCarryover([old], [fresh]);
    expect(result.lines).toEqual([fresh]);
    expect(result.carried).toEqual({ manual_exclude: 0, re_include: 0, rep: 0 });
    expect(result.edits).toEqual([]);
    expect(fresh).toEqual(old);
  });
  it("does not report ordinary included payable lines as unmatched manual edits", () => {
    const result = applyCarryover([base], [{ ...base, extended_price: 101 }]);
    expect(result.unmatched).toEqual([]);
    expect(result.snapshot_overrides).toBe(0);
  });
  it("uses input ordinal for identical duplicate ties, including non-overrides", () => {
    const result = applyCarryover([base, { ...base, writing_rep: "Second", rep_parse_confidence: "manual" }], [base, base]);
    expect(result.lines.map((line) => line.writing_rep)).toEqual(["Kim", "Second"]);
  });
  it("carries a legacy snapshot onto a fresh P21 line-number key", () => {
    const old = { ...base, flags: {}, included: false, exclusion_reason: "manual" };
    const result = applyCarryover([old], [base]);
    expect(result.lines[0].included).toBe(false);
    expect(result.carried.manual_exclude).toBe(1);
    expect(result.unmatched).toEqual([]);
  });
  it("reports differing legacy duplicate overrides as ambiguous", () => {
    const old = [
      { ...base, flags: {}, included: false, exclusion_reason: "manual" },
      { ...base, flags: {}, writing_rep: "Second", rep_parse_confidence: "manual" },
    ];
    const fresh = [base, { ...base, flags: { oe_line_no: "2" } }];
    const result = applyCarryover(old, fresh);
    expect(result.lines).toEqual(fresh);
    expect(result.carried).toEqual({ manual_exclude: 0, re_include: 0, rep: 0 });
    expect(result.unmatched).toHaveLength(2);
    expect(result.unmatched.every((edit) => edit.ambiguous)).toBe(true);
  });
  it("requires exact matching when the snapshot has oe_line_no", () => {
    const old = { ...base, included: false, exclusion_reason: "manual" };
    const fresh = { ...base, flags: { oe_line_no: "2" } };
    const result = applyCarryover([old], [fresh]);
    expect(result.lines).toEqual([fresh]);
    expect(result.unmatched[0].line_key).toBe(lineKey(old));
  });
  it("reserves exact matches before fallback and never matches fresh lines twice", () => {
    const legacy = { ...base, flags: {}, included: false, exclusion_reason: "manual" };
    const exact = { ...base, writing_rep: "Exact", rep_parse_confidence: "manual" };
    const result = applyCarryover([legacy, exact, legacy], [base, { ...base, flags: { oe_line_no: "2" } }]);
    expect(result.lines[0]).toMatchObject({ included: true, writing_rep: "Exact" });
    expect(result.lines[1]).toMatchObject({ included: true, writing_rep: "Kim" });
    expect(result.carried).toEqual({ manual_exclude: 0, re_include: 0, rep: 1 });
    expect(result.unmatched).toHaveLength(2);
    expect(result.unmatched.every((edit) => edit.ambiguous)).toBe(true);
  });
  it("carries all 1550 mixed legacy and exact overrides with concrete counts", () => {
    const fresh = Array.from({ length: 1550 }, (_, index) => ({
      ...base, order_no: String(index), flags: { oe_line_no: "1" },
      included: index % 3 !== 1, exclusion_reason: index % 3 === 1 ? "out_of_scope" : null,
    }));
    const old = fresh.map((line, index) => ({
      ...line, flags: { ...(index % 2 === 0 ? {} : line.flags), ...(index % 3 === 1 ? { manual_include: true } : {}) },
      included: index % 3 !== 0, exclusion_reason: index % 3 === 0 ? "manual" : null,
      writing_rep: index % 3 === 2 ? `Rep ${index}` : line.writing_rep,
      rep_parse_confidence: index % 3 === 2 ? "manual" : "parsed",
    }));
    const result = applyCarryover(old, fresh);
    expect(result.lines).toHaveLength(1550);
    expect(result.carried).toEqual({ manual_exclude: 517, re_include: 517, rep: 516 });
    expect(result.snapshot_overrides).toBe(1550);
    expect(result.unmatched).toEqual([]);
    result.lines.forEach((line, index) => {
      expect(line.included).toBe(index % 3 !== 0);
      expect(line.writing_rep).toBe(index % 3 === 2 ? `Rep ${index}` : "Kim");
      expect(line.spiff_amount).toBe(5);
      expect(line.flags).toEqual({ ...fresh[index].flags, ...(index % 3 === 1 ? { manual_include: true } : {}) });
    });
  });
});
describe("SPIFF stable line identity", () => {
  it("ignores editable free text and mirrors SQL numeric/date formatting", () => {
    const original = { ...base, po_no: "PO1", item_desc: "Chair", writing_rep: "Kim" };
    expect(lineKey({ ...original, po_no: "PO2", item_desc: "Changed", writing_rep: "Marty" })).toBe(lineKey(original));
    expect(lineKey({ ...base, qty_ordered: "2.000", extended_price: "100.0000" })).toBe("C1|123|1|CHAIR|2026-09-01|2|100");
    expect(lineKey({ ...base, flags: {}, last_invoice_date: "2026-09-02" })).toBe("C1|123|CHAIR|2026-09-02|2|100");
    expect(lineKey({ ...base, qty_ordered: 1e-7, extended_price: -0 })).toBe("C1|123|1|CHAIR|2026-09-01|0.0000001|0");
  });
});