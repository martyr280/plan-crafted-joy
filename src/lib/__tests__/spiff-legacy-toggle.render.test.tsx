// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { LEGACY_AMOUNT_BLOCK_REASON } from "../spiff/amount";

const ports = vi.hoisted(() => ({
  updatedAt: "2026-10-02T00:00:00Z",
  generatedAt: "2026-10-01T00:00:00Z" as string | null,
  missingProgram: false,
  update: vi.fn(), rebuild: vi.fn(), toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: ports.toastError, success: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@tanstack/react-router", async () => {
  const R = await import("react");
  return { createFileRoute: () => (opts: unknown) => ({ options: opts }), lazyRouteComponent: (imp: () => Promise<any>, name = "default") => R.lazy(() => imp().then((m) => ({ default: m[name] }))) };
});
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => ports.rebuild }));
vi.mock("@/lib/spiff.functions", () => ({ generateSpiffRun: {}, rebuildSpiffChecks: {}, downloadSpiffWorkbook: {}, sendSpiffForApproval: {}, sendSpiffToAp: {} }));
vi.mock("@/lib/usage-log", () => ({ logUsage: vi.fn(), useModuleView: vi.fn() }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "synthetic-admin" } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (table: string) => {
  const rows = table === "spiff_runs" ? [{ id: "run", status: "draft", quarter_label: "Q3-2026", totals: { generated_at: ports.generatedAt }, created_at: "2026-10-01T00:00:00Z" }]
    : table === "spiff_programs" ? [{ id: ports.missingProgram ? "other-program" : "program", customer_id: "C1", customer_name: "Mock customer", rate: 0.05, updated_at: ports.updatedAt, rep_org: "Mock", product_scope: "all", payout_mode: "single_check", min_check_amount: 0 }]
    : table === "spiff_run_lines" ? [{ id: "line", run_id: "run", program_id: "program", customer_id: "C1", included: false, exclusion_reason: "not_invoiced", extended_price: 200, spiff_amount: 0, flags: { oe_line_no: "1" }, writing_rep: "Kim", rep_parse_confidence: "parsed", item_id: "CHAIR" }] : [];
  const result = { data: rows, error: null, count: rows.length };
  const q: any = new Proxy({}, { get: (_t, key) => {
    if (key === "then") return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
    if (key === "update") return (patch: unknown) => { ports.update(table, patch); return { eq: async () => ({ error: null }) }; };
    return () => q;
  } });
  return q;
} } }));
import { Route } from "@/routes/_app.spiff";

afterEach(() => {
  cleanup(); vi.clearAllMocks();
  ports.updatedAt = "2026-10-02T00:00:00Z";
  ports.generatedAt = "2026-10-01T00:00:00Z";
  ports.missingProgram = false;
});

async function includeLine() {
  const Page = (Route as any).options.component as React.ComponentType;
  render(<React.Suspense fallback={null}><Page /></React.Suspense>);
  fireEvent.click(await screen.findByRole("button", { name: "Incl." }, { timeout: 10000 }));
}

describe("SPIFF legacy toggle (real rendered page, mocked database)", () => {
  it.each(["changed program", "missing generated_at", "program not loaded"])("%s blocks toggle, shows reason, performs no UPDATE or rebuild", { timeout: 20000 }, async (scenario) => {
    if (scenario === "missing generated_at") ports.generatedAt = null;
    if (scenario === "program not loaded") ports.missingProgram = true;
    await includeLine();
    await waitFor(() => expect(ports.toastError).toHaveBeenCalledWith(LEGACY_AMOUNT_BLOCK_REASON));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(ports.update).not.toHaveBeenCalled();
    expect(ports.rebuild).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Incl." })).toBeTruthy();
  });
  it("unchanged program recovers amount and generation flags in one UPDATE", { timeout: 20000 }, async () => {
    ports.updatedAt = "2026-09-01T00:00:00Z";
    await includeLine();
    await waitFor(() => expect(ports.update).toHaveBeenCalledTimes(1));
    expect(ports.update).toHaveBeenCalledWith("spiff_run_lines", { included: true, exclusion_reason: null, spiff_amount: 10, flags: { oe_line_no: "1", manual_include: true, gen_rate: 0.05, gen_amount: 10 } });
    await waitFor(() => expect(ports.rebuild).toHaveBeenCalledTimes(1));
    expect(ports.toastError).not.toHaveBeenCalled();
  });
});