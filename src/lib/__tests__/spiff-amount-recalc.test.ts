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
const GEN = { oe_line_no: "1", gen_rate: RATE, gen_amount: 61.7285 };
const line = { included: true, exclusion_reason: null as string | null, flags: { ...GEN } as Record<string, unknown>, extended_price: 1234.57, spiff_amount: 61.7285 };
const program = { id: "program", customer_id: "C1", customer_name: "Mock", product_scope: "all", rate: RATE, payout_mode: "per_writing_rep", payee_name: "Mock", min_check_amount: 0 };
const roundTrip = <T extends typeof line>(l: T) => {
  const ex = { ...l, ...manualIncludePatch(l, { included: false, exclusion_reason: "manual" }) } as T;
  return { ex, back: { ...ex, ...manualIncludePatch(ex, { included: true, exclusion_reason: null }) } as T };
};

describe("SPIFF amount on include/exclude (gen_amount)", () => {
  it("(a) new-run round-trip restores flags.gen_amount exactly even if program rate changed to 3%", () => {
    const { ex, back } = roundTrip(line);
    expect(ex.spiff_amount).toBe(0);
    expect(back.spiff_amount).toBe(61.7285);
    expect(back.flags).toMatchObject({ gen_amount: 61.7285, gen_rate: RATE, manual_include: true });
    expect(manualIncludePatch.length).toBe(2); // no rate argument any more
  });
  it("(b) legacy Q1 negative-ext unflagged line (-12.34): round-trip leaves amount, patch has no spiff_amount", () => {
    const legacy = { ...line, flags: { oe_line_no: "1" }, extended_price: -246.8, spiff_amount: -12.34 };
    const p1 = manualIncludePatch(legacy, { included: false, exclusion_reason: "manual" });
    expect("spiff_amount" in p1).toBe(false);
    expect(p1).toMatchObject({ included: false, exclusion_reason: "manual" });
    expect(roundTrip(legacy).back.spiff_amount).toBe(-12.34);
  });
  it("(b) legacy 1.5%-rate line with program now at 3%: round-trip leaves amount, patch has no spiff_amount", () => {
    const legacy = { ...line, flags: { oe_line_no: "2" }, extended_price: 1000, spiff_amount: 15 };
    const { ex, back } = roundTrip(legacy);
    expect("spiff_amount" in manualIncludePatch(ex, { included: true, exclusion_reason: null })).toBe(false);
    expect(back.spiff_amount).toBe(15);
  });
  it("(c) credit with gen_amount: include -> 0 (return_credit flag and negative ext)", () => {
    for (const c of [{ ...line, flags: { return_credit: true, gen_amount: 0 }, extended_price: 100 }, { ...line, flags: { gen_amount: 5 }, extended_price: -100 }]) {
      const off = { ...c, included: false, exclusion_reason: "return_credit", spiff_amount: 0 };
      expect(isCreditLine(off)).toBe(true);
      expect(manualIncludePatch(off, { included: true, exclusion_reason: null }).spiff_amount).toBe(0);
    }
  });
  it("checks rebuilt from toggled lines sum to included spiff_amount", () => {
    let lines = [
      { ...line, writing_rep: "Kim", rep_parse_confidence: "parsed" },
      { ...line, flags: { gen_amount: 10 }, extended_price: 200, spiff_amount: 10, writing_rep: "Lee", rep_parse_confidence: "parsed" },
      { ...line, flags: { gen_amount: 4 }, extended_price: 80, included: false, exclusion_reason: "out_of_scope", spiff_amount: 0, writing_rep: "Kim", rep_parse_confidence: "parsed" },
    ];
    lines = lines.map((l, i) => i === 0 ? { ...l, ...manualIncludePatch(l, { included: false, exclusion_reason: "manual" }) } as typeof l
      : i === 2 ? { ...l, ...manualIncludePatch(l, { included: true, exclusion_reason: null }) } as typeof l : l);
    const total = buildChecksForProgram(program as any, lines as any).reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(lines.filter((l) => l.included).reduce((s, l) => s + l.spiff_amount, 0));
    expect(total).toBe(14);
  });
  it("Generate formula is byte-identical to the old inline rule on a sample", () => {
    const old = (included: boolean, ext: number, rate: number) => included ? +(ext * Number(rate)).toFixed(6) : 0;
    for (const ext of [0, 0.01, 1, 99.99, 1234.567891, 100000.123, 3.3333333]) for (const rate of [0.01, 0.02, 0.025, 0.05, 0.075, 0.1]) {
      for (const included of [true, false]) expect(computeLineSpiff({ included, extended_price: ext, isCredit: false }, rate)).toBe(old(included, ext, rate));
    }
  });
  it("recomputeCarriedAmounts only touches flipped lines, skips legacy, and returns spiff_amount audit edits", () => {
    const lines = [{ ...line, spiff_amount: 0 }, { ...line, spiff_amount: 7 }, { ...line, flags: {}, spiff_amount: -3 }];
    const edits = recomputeCarriedAmounts(lines, [{ lineIndex: 0, field: "included" }, { lineIndex: 1, field: "writing_rep" }, { lineIndex: 2, field: "included" }]);
    expect(lines.map((l) => l.spiff_amount)).toEqual([61.7285, 7, -3]);
    expect(edits).toEqual([{ lineIndex: 0, field: "spiff_amount", old_value: "0", new_value: "61.7285" }]);
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
  it("(d) Generate writes gen_amount/gen_rate; excluded spiff_amount still 0", async () => {
    ports.lines.mockResolvedValueOnce([]);
    await generateSpiffRunCore({ quarterLabel: "Q3-2026", dateFrom: "2026-07-01", dateTo: "2026-10-01", userId: "mock-admin" });
    expect(ports.rpc.mock.calls[0][1].p_lines[0]).toMatchObject({ included: false, exclusion_reason: "not_invoiced", spiff_amount: 0, flags: { gen_rate: RATE, gen_amount: 5, not_invoiced: true, oe_line_no: "1" } });
  });
  it("(e) carry-over keeps whole flags object and writes a spiff_amount audit row", async () => {
    await generateSpiffRunCore({ quarterLabel: "Q3-2026", dateFrom: "2026-07-01", dateTo: "2026-10-01", userId: "mock-admin" });
    const args = ports.rpc.mock.calls[0][1];
    expect(args.p_lines[0].flags).toEqual({ oe_line_no: "1", not_invoiced: true, gen_rate: RATE, gen_amount: 5, manual_include: true });
    const inc = args.p_audit.find((a: any) => a.field === "included");
    const amt = args.p_audit.find((a: any) => a.field === "spiff_amount");
    expect(amt).toMatchObject({ old_value: "0", new_value: "5", source: "generate_carryover", changed_by: "mock-admin" });
    expect(Object.keys(amt).sort()).toEqual(Object.keys(inc).sort());
  });
  it("fresh not_invoiced line re-included by carry-over gets gen_amount and checks equal it", async () => {
    await generateSpiffRunCore({ quarterLabel: "Q3-2026", dateFrom: "2026-07-01", dateTo: "2026-10-01", userId: "mock-admin" });
    const args = ports.rpc.mock.calls[0][1];
    expect(args.p_lines[0]).toMatchObject({ included: true, spiff_amount: 5, flags: { manual_include: true } });
    expect(args.p_checks[0]).toMatchObject({ amount: 5, line_count: 1 });
  });
});

describe("(g) wiring", () => {
  it("toggle and carry-over share amountForIncludeChange; Generate uses computeLineSpiff; formula not duplicated", () => {
    const screen = readFileSync("src/routes/_app.spiff.tsx", "utf8");
    const patch = readFileSync("src/lib/spiff/manual-include.ts", "utf8");
    const server = readFileSync("src/lib/spiff.server.ts", "utf8");
    expect(screen).toContain("patch = manualIncludePatch(line, patch);");
    expect(screen).not.toContain("Program rate not loaded");
    expect(screen).toMatch(/async function toggleIncluded[\s\S]*?updateLine\(/);
    expect(patch).toContain("amountForIncludeChange(");
    expect(server).toMatch(/const spiff = computeLineSpiff\(\{ included, extended_price: extForRow, isCredit: isReturnCredit \}, program\.rate\)/);
    expect(server).toContain("recomputeCarriedAmounts(carryover.lines, carryover.edits)");
    expect(server).toMatch(/flags\.gen_amount = computeLineSpiff\(\{ included: true, extended_price: extForRow, isCredit: isReturnCredit \}, program\.rate\)/);
    for (const src of [screen, patch, server]) expect(src).not.toMatch(/toFixed\(6\)/);
  });
});
