import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
const m = vi.hoisted(() => ({ lines: [] as any[], checks: [] as any[] }));
vi.mock("../spiff/fetch-all.server", () => ({ fetchAllRunLines: async () => m.lines, fetchAllRunChecks: async () => m.checks }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: (t: string) => {
  const q: any = { select: () => q, eq: () => q, in: () => q,
    single: async () => ({ data: { id: "run", quarter_label: "Q3-2026", totals: {} }, error: null }),
    order: async () => ({ data: [{ id: "p", customer_id: "C1", customer_name: "Mock", rep_org: "Org", rate: 0.05, payout_mode: "single_check", payee_name: "Mock", min_check_amount: 0, active: true }], error: null }) };
  return t ? q : q;
} } }));
import { buildSpiffWorkbook } from "../spiff/workbook.server";
import { buildChecksForProgram } from "../spiff.server";

describe("(f) workbook SPIFF column", () => {
  it("credit/negative lines show 0 and totals match checks (writes stored spiff_amount)", async () => {
    const base = { program_id: "p", customer_id: "C1", order_date: "2026-07-01", writing_rep: "Kim", rep_parse_confidence: "parsed", included: true };
    m.lines = [
      { ...base, extended_price: 100, spiff_amount: 5, flags: {} },
      { ...base, extended_price: 80, spiff_amount: 0, flags: { return_credit: true } },
      { ...base, extended_price: -40, spiff_amount: 0, flags: {} },
    ];
    const program = { id: "p", customer_id: "C1", payout_mode: "single_check", payee_name: "Mock", min_check_amount: 0 } as any;
    m.checks = buildChecksForProgram(program, m.lines).map((c) => ({ ...c, program_id: "p", customer_id: "C1" }));
    const { buffer } = await buildSpiffWorkbook("run");
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet("C1")!;
    expect([3, 4, 5].map((r) => ws.getCell(r, 10).value)).toEqual([5, 0, 0]);
    const vals = [3, 4, 5].map((r) => Number(ws.getCell(r, 10).value));
    expect((ws.getCell(6, 10).value as any).formula).toBe("SUM(J3:J5)");
    expect(vals.reduce((a, b) => a + b, 0)).toBe(m.checks.reduce((s: number, c: any) => s + c.amount, 0));
  });
});
