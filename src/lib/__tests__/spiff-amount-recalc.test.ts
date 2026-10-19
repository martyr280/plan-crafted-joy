import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const ports = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), bridge: vi.fn(), lines: vi.fn(), history: vi.fn(), activity: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: ports.from, rpc: ports.rpc } }));
vi.mock("../p21.server", () => ({ runJob: ports.bridge }));
vi.mock("../spiff/fetch-all.server", () => ({ fetchAllRunLines: ports.lines, fetchAllRows: ports.history }));
import { computeLineSpiff, isCreditLine } from "../spiff/amount";
import { manualIncludePatch } from "../spiff/manual-include";
import { buildChecksForProgram, generateSpiffRunCore, recomputeCarriedAmounts } from "../spiff.server";

const RATE = 0.05;
const line = { included: true, exclusion_reason: null as string | null, flags: { oe_line_no: "1" } as Record<string, unknown>, extended_price: 1234.57, spiff_amount: 61.7285 };
const program = { id: "program", customer_id: "C1", customer_name: "Mock", product_scope: "all", rate: RATE, payout_mode: "per_writing_rep", payee_name: "Mock", min_check_amount: 0 };

describe("SPIFF amount recalculation on include/exclude", () => {
  it("(a) non-credit re-include gets ext*rate", () => {
    const patch = manualIncludePatch({ ...line, included: false, exclusion_reason: "manual", spiff_amount: 0 }, { included: true, exclusion_reason: null }, RATE);
    expect(patch.spiff_amount).toBe(61.7285);
    expect(patch.flags).toMatchObject({ manual_include: true });
  });
  it("(b) credit re-include via return_credit flag stays 0", () => {
    const credit = { ...line, included: false, exclusion_reason: "return_credit", flags: { return_credit: true }, extended_price: 100, spiff_amount: 0 };
    expect(manualIncludePatch(credit, { included: true, exclusion_reason: null }, RATE).spiff_amount).toBe(0);
  });
  it("(b) credit re-include via negative extended_price stays 0", () => {
    const credit = { ...line, included: false, exclusion_reason: "return_credit", flags: {}, extended_price: -100, spiff_amount: 0 };
    expect(isCreditLine(credit)).toBe(true);
    expect(manualIncludePatch(credit, { included: true, exclusion_reason: null }, RATE).spiff_amount).toBe(0);
  });
  it("(c) exclude -> 0, same as Generate's excluded value", () => {
    const patch = manualIncludePatch(line, { included: false, exclusion_reason: "manual" }, RATE);
    expect(patch).toMatchObject({ included: false, exclusion_reason: "manual", spiff_amount: 0 });
    expect(computeLineSpiff({ included: false, extended_price: 1234.57, isCredit: false }, RATE)).toBe(0);
  });
  it("(d) toggle exclude then include returns the original amount exactly", () => {
    const excluded = { ...line, ...manualIncludePatch(line, { included: false, exclusion_reason: "manual" }, RATE) } as typeof line;
    const back = { ...excluded, ...manualIncludePatch(excluded, { included: true, exclusion_reason: null }, RATE) };
    expect(back.spiff_amount).toBe(line.spiff_amount);
  });
  it("(e) checks rebuilt from toggled lines sum to included spiff_amount", () => {
    let lines = [
      { ...line, writing_rep: "Kim", rep_parse_confidence: "parsed" },
      { ...line, extended_price: 200, spiff_amount: 10, writing_rep: "Lee", rep_parse_confidence: "parsed" },
      { ...line, extended_price: 80, included: false, exclusion_reason: "out_of_scope", spiff_amount: 0, writing_rep: "Kim", rep_parse_confidence: "parsed" },
    ];
    lines = lines.map((l, i) => i === 0 ? { ...l, ...manualIncludePatch(l, { included: false, exclusion_reason: "manual" }, RATE) } as typeof l
      : i === 2 ? { ...l, ...manualIncludePatch(l, { included: true, exclusion_reason: null }, RATE) } as typeof l : l);
    const checks = buildChecksForProgram(program as any, lines as any);
    const total = checks.reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(lines.filter((l) => l.included).reduce((s, l) => s + l.spiff_amount, 0));
    expect(total).toBe(14);
  });
  it("Generate formula is byte-identical to the old inline rule on a sample", () => {
    const old = (included: boolean, ext: number, rate: number) => included ? +(ext * Number(rate)).toFixed(6) : 0;
    for (const ext of [0, 0.01, 1, 99.99, 1234.567891, 100000.123, 3.3333333]) for (const rate of [0.01, 0.02, 0.025, 0.05, 0.075, 0.1]) {
      for (const included of [true, false]) expect(computeLineSpiff({ included, extended_price: ext, isCredit: false }, rate)).toBe(old(included, ext, rate));
    }
  });
  it("recomputeCarriedAmounts only touches lines whose included was flipped", () => {
    const lines = [{ ...line, program_id: "program", spiff_amount: 0 }, { ...line, program_id: "program", spiff_amount: 7 }];
    recomputeCarriedAmounts(lines, [{ lineIndex: 0, field: "included" }, { lineIndex: 1, field: "writing_rep" }], [program]);
    expect(lines.map((l) => l.spiff_amount)).toEqual([61.7285, 7]);
  });
});

describe("(f) carry-over of a manual include recomputes the amount in Generate", () => {
  const raw = { customer_id: "C1", order_no: "123", line_no: "1", item_id: "CHAIR", last_invoice_date: "2026-09-01", qty_ordered: 2, extended_price: 100, invoiced_qty: 0, invoiced_amount: 0 };
  const old = { id: "old", ...raw, program_id: "program", invoice_date: raw.last_invoice_date, included: true, exclusion_reason: null, writing_rep: null, rep_parse_confidence: "unmatched", spiff_amount: 0, flags: { oe_line_no: "1", manual_include: true } };
  beforeEach(() => {
    vi.clearAllMocks();
    ports.from.mockImplementation((table: string) => {
      if (table === "activity_events") return { insert: ports.activity };
      if (table === "spiff_programs") { const q: any = { select: () => q, eq: () => q, order: async () => ({ data: [{ ...program, payout_mode: "single_check" }], error: null }) }; return q; }
      if (table === "spiff_runs") { const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: { id: "run", status: "draft" }, error: null }) }; return q; }
      throw new Error(`Unexpected table ${table}`);
    });
    ports.lines.mockResolvedValue([old]); ports.history.mockResolvedValue([]);
    ports.rpc.mockResolvedValue({ data: { lines: 1, checks: 1, audit: 2 }, error: null });
    ports.activity.mockResolvedValue({ error: null });
    ports.bridge.mockImplementation(async (_k: string, payload: { slug: string }) => {
      if (payload.slug === "spiff-schema") return { result: { rows: [
        ...["order_no", "line_no", "qty_invoiced", "extended_price"].map((column_name) => ({ table_name: "invoice_line", column_name })),
        { table_name: "oe_line", column_name: "line_no" },
      ] } };
      if (payload.slug === "spiff-all") return { result: { rows: [raw] } };
      if (payload.slug === "spiff-aging") return { result: { rows: [] } };
      throw new Error("Unexpected bridge call");
    });
  });
  it("fresh not_invoiced line re-included by carry-over gets ext*rate and checks equal it", async () => {
    await generateSpiffRunCore({ quarterLabel: "Q3-2026", dateFrom: "2026-07-01", dateTo: "2026-10-01", userId: "mock-admin" });
    const args = ports.rpc.mock.calls[0][1];
    expect(args.p_lines[0]).toMatchObject({ included: true, spiff_amount: 5, flags: { manual_include: true } });
    expect(args.p_checks[0]).toMatchObject({ amount: 5, line_count: 1 });
  });
});

describe("(g) wiring", () => {
  it("toggle path, manualIncludePatch and Generate all use computeLineSpiff; formula not duplicated", () => {
    const screen = readFileSync("src/routes/_app.spiff.tsx", "utf8");
    const patch = readFileSync("src/lib/spiff/manual-include.ts", "utf8");
    const server = readFileSync("src/lib/spiff.server.ts", "utf8");
    expect(screen).toContain("patch = manualIncludePatch(line, patch, program.rate)");
    expect(screen).toMatch(/async function toggleIncluded[\s\S]*?updateLine\(/);
    expect(patch).toContain("computeLineSpiff(");
    expect(server).toMatch(/const spiff = computeLineSpiff\(\{ included, extended_price: extForRow, isCredit: isReturnCredit \}, program\.rate\)/);
    expect(server).toContain("recomputeCarriedAmounts(carryover.lines, carryover.edits");
    for (const src of [screen, patch, server]) expect(src).not.toMatch(/toFixed\(6\)/);
  });
});
