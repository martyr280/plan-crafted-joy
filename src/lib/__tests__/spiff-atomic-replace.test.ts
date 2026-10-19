import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const ports = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), bridge: vi.fn(), lines: vi.fn(), history: vi.fn(), activity: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: ports.from, rpc: ports.rpc } }));
vi.mock("../p21.server", () => ({ runJob: ports.bridge }));
vi.mock("../spiff/fetch-all.server", () => ({ fetchAllRunLines: ports.lines, fetchAllRows: ports.history }));
import { generateSpiffRunCore } from "../spiff.server";
const opts = { quarterLabel: "Q3-2026", dateFrom: "2026-07-01", dateTo: "2026-10-01", userId: "mock-admin" };
const program = { id: "program", customer_id: "C1", customer_name: "Mock", product_scope: "all", rate: 0.05, payout_mode: "single_check", payee_name: "Mock", min_check_amount: 0 };
const raw = { customer_id: "C1", order_no: "123", line_no: "1", item_id: "CHAIR", last_invoice_date: "2026-09-01", qty_ordered: 2, extended_price: 100, invoiced_qty: 2, invoiced_amount: 100 };
const old = { id: "old", ...raw, invoice_date: raw.last_invoice_date, included: false, exclusion_reason: "manual", writing_rep: null, rep_parse_confidence: "unmatched", spiff_amount: 5, flags: { oe_line_no: "1" } };
const history = [{ id: "edit", line_id: "old", source: "app", field: "included", new_value: "false", changed_at: "2026-10-19" }];
function setup(isNew = false) {
  ports.from.mockImplementation((table: string) => {
    if (table === "activity_events") return { insert: ports.activity };
    if (table === "spiff_programs") {
      const q = { select: () => q, eq: () => q, order: async () => ({ data: [program], error: null }) };
      return q;
    }
    if (table === "spiff_runs") {
      const q = { select: () => q, eq: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: isNew ? null : { id: "run", status: "draft" }, error: null }),
        insert: () => q, single: async () => ({ data: { id: "run" }, error: null }),
      };
      return q;
    }
    throw new Error(`Unexpected direct table access: ${table}`);
  });
  ports.lines.mockResolvedValue([old]); ports.history.mockResolvedValue(history);
  ports.rpc.mockResolvedValue({ data: { lines: 1, checks: 1, audit: 2 }, error: null });
  ports.activity.mockResolvedValue({ error: null });
  ports.bridge.mockImplementation(async (_kind: string, payload: { slug: string }) => {
    if (payload.slug === "spiff-schema") return { result: { rows: [
      ...["order_no", "line_no", "qty_invoiced", "extended_price"].map((column_name) => ({ table_name: "invoice_line", column_name })),
      { table_name: "oe_line", column_name: "line_no" },
    ] } };
    if (payload.slug === "spiff-all") return { result: { rows: [raw] } };
    if (payload.slug === "spiff-aging") return { result: { rows: [] } };
    throw new Error("Unexpected bridge call");
  });
}
describe("SPIFF atomic replacement (mock ports only)", () => {
  beforeEach(() => { vi.clearAllMocks(); setup(); });
  it("replace is one RPC call with all lines/checks/audit and no direct delete/insert on protected tables", async () => {
    await generateSpiffRunCore(opts);
    expect(ports.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = ports.rpc.mock.calls[0];
    expect(name).toBe("replace_spiff_run");
    expect(args.p_lines).toHaveLength(1); expect(args.p_checks).toHaveLength(1); expect(args.p_audit).toHaveLength(2);
    expect(args.p_lines[0]).toMatchObject({ included: false, exclusion_reason: "manual", spiff_amount: 0 });
    expect(args.p_checks[0]).toMatchObject({ amount: 0, line_count: 0, run_id: "run" });
    expect(ports.from.mock.calls.map(([table]) => table)).toEqual(["spiff_programs", "spiff_runs", "activity_events"]);
  });
  it("RPC failure throws and performs no other mutation", async () => {
    ports.rpc.mockResolvedValueOnce({ data: null, error: { message: "run changed during generate" } });
    await expect(generateSpiffRunCore(opts)).rejects.toThrow("run changed during generate");
    expect(ports.activity).not.toHaveBeenCalled();
    expect(ports.from.mock.calls.map(([table]) => table)).toEqual(["spiff_programs", "spiff_runs"]);
  });
  it("expected counts passed equal snapshot length and edit-history length", async () => {
    ports.lines.mockResolvedValueOnce(Array.from({ length: 1550 }, () => old));
    ports.history.mockResolvedValueOnce(Array.from({ length: 1201 }, () => history[0]));
    await generateSpiffRunCore(opts);
    expect(ports.rpc.mock.calls[0][1]).toMatchObject({ p_expected_line_count: 1550, p_expected_edit_count: 1201 });
  });
  it("new runs also use replacement RPC with zero expected counts", async () => {
    setup(true);
    await generateSpiffRunCore(opts);
    expect(ports.rpc.mock.calls[0][1]).toMatchObject({ p_expected_line_count: 0, p_expected_edit_count: 0 });
    expect(ports.lines).not.toHaveBeenCalled(); expect(ports.history).not.toHaveBeenCalled();
  });
  it("migration enforces definer boundary, locked draft, and restricted execution", () => {
    const sql = readFileSync("drizzle/migrations/0019_spiff_atomic_replace_append_only.sql", "utf8").split("/* Rollback")[0];
    for (const required of ["SECURITY DEFINER", "SET search_path = public, pg_temp", "auth.role()", "<> 'service_role'", "FOR UPDATE", "REVOKE EXECUTE ON FUNCTION public.replace_spiff_run(uuid,int,int,jsonb,jsonb,jsonb,jsonb,date,date,uuid) FROM PUBLIC, anon, authenticated;", "GRANT EXECUTE ON FUNCTION public.replace_spiff_run(uuid,int,int,jsonb,jsonb,jsonb,jsonb,date,date,uuid) TO service_role;", "LOCK TABLE public.spiff_run_lines", "'_regenerate'", "IS DISTINCT FROM p_expected_edit_count"] ) expect(sql).toContain(required);
  });
});
