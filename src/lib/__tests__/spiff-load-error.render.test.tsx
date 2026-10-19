// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const st = vi.hoisted(() => ({ fail: true }));
const toastMock = vi.hoisted(() => ({
  error: vi.fn(), success: vi.fn(), dismiss: vi.fn(), message: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  createFileRoute: () => (opts: any) => ({ options: opts }),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: () => () => { throw new Error("server functions are never called in this test"); },
}));
vi.mock("@/lib/spiff.functions", () => ({
  generateSpiffRun: {}, rebuildSpiffChecks: {}, downloadSpiffWorkbook: {}, sendSpiffForApproval: {}, sendSpiffToAp: {},
}));
vi.mock("@/lib/usage-log", () => ({ logUsage: () => {}, useModuleView: () => {} }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "synthetic-admin" } }) }));
vi.mock("@/lib/spiff/page-all", () => ({
  pageAll: vi.fn(async () => {
    if (st.fail) throw new Error("page starting at 1000 failed: synthetic");
    return [];
  }),
}));
vi.mock("@/integrations/supabase/client", () => {
  const RUN = { id: "run-1", quarter_label: "Q3-2026", status: "draft", created_at: "2026-10-01T00:00:00Z", totals: {} };
  const chain = (table: string): any => {
    const result = { data: table === "spiff_runs" ? [RUN] : [], error: null, count: 0 };
    const q: any = new Proxy(() => {}, {
      get: (_t, p) => (p === "then" ? (res: any, rej: any) => Promise.resolve(result).then(res, rej) : () => q),
      apply: () => q,
    });
    return q;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import { Route } from "@/routes/_app.spiff";

afterEach(() => { cleanup(); vi.clearAllMocks(); st.fail = true; });

describe("SPIFF run detail load failure (rendered)", () => {
  it("failed load shows the alert card, disables actions, one keyed toast; Retry clears both", async () => {
    const Page = (Route as any).options.component as React.ComponentType;
    render(<Page />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the full run");
    for (const name of [/Workbook/, /Send for approval/, /Send to AP/]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    const errorCalls = toastMock.error.mock.calls.filter((c) => c[1]?.id === "spiff-load-error");
    expect(toastMock.error.mock.calls).toHaveLength(1);
    expect(errorCalls).toHaveLength(1);

    toastMock.dismiss.mockClear();
    st.fail = false;
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(toastMock.dismiss).toHaveBeenCalledWith("spiff-load-error");
  });
});
