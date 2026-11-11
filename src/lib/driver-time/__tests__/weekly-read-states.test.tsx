// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";

vi.mock("@tanstack/react-start", async () => ({
  createServerFn: (await import("./fixtures/weekly-db")).serverFnChain,
}));
vi.mock("@/lib/branch-guard", () => ({ denyLegacyBranchAccess: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => ({
  supabaseAdmin: (await import("./fixtures/weekly-db")).supabaseAdminMock,
}));

const ports = vi.hoisted(() => ({
  week: {} as Record<string, unknown>,
  weekCalls: [] as unknown[][],
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/usage-log", () => ({ useModuleView: () => {} }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    roles: ["ops_logistics_admin"],
    hasRole: (role: string) => role === "ops_logistics_admin",
  }),
}));
vi.mock("@/hooks/useDriverTime", () => ({
  useDriverTimeWeek: (...args: unknown[]) => {
    ports.weekCalls.push(args);
    return ports.week;
  },
  useRunDriverTimeSweep: () => ({ mutate: vi.fn(), isPending: false }),
  useDriverTimeConfig: () => ({
    isLoading: false,
    data: { settings: { warehouseAddressIds: [], thresholdMinutes: 90 }, drivers: [], error: null },
  }),
  useSaveDriverTimeConfig: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDriverTimeEvent: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveWarehouseActual: () => ({ mutate: vi.fn(), isPending: false }),
  useSamsaraDiagnostics: () => ({ data: null, isPending: false, mutate: vi.fn() }),
  useDriverPayRates: () => ({
    isLoading: false,
    isError: false,
    data: { drivers: [], rates: [], rosterError: null },
    refetch: vi.fn(),
  }),
  useAddDriverPayRate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDriverPayRate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { Route } from "@/routes/_app.driver-time";
import { getDriverTimeWeek } from "@/lib/driver-time.functions";
import { resetWeeklyDb, weekTables, type Category } from "./fixtures/weekly-db";

const FIGURE = "At least $80 (4h priced, 6h not costed; 2 unpriced)";
const RUN = {
  id: "run-1",
  started_at: "2026-11-10T12:00:00Z",
  week_start: "2026-11-09",
  week_end: "2026-11-13",
  status: "completed",
  drivers_scanned: 4,
  events_found: 5,
  error: "synthetic sweep note",
};

const runWeek = getDriverTimeWeek as unknown as (input: {
  data: unknown;
  context: { userId: string };
}) => Promise<Record<string, unknown>>;

async function handlerWeek(mix: Category[]) {
  resetWeeklyDb(["ops_logistics_admin"], weekTables(mix, { runs: [RUN] }));
  return runWeek({ data: { weekStart: "2026-11-09" }, context: { userId: "synthetic-user" } });
}

let loaded: Record<string, unknown>;
let empty: Record<string, unknown>;
beforeAll(async () => {
  loaded = await handlerWeek(["F", "P", "U", "M"]);
  empty = await handlerWeek([]);
});

function state(over: Record<string, unknown>) {
  ports.week = {
    isLoading: false,
    isError: false,
    isFetching: false,
    data: undefined,
    error: null,
    refetch: vi.fn(),
    ...over,
  };
}

const Page = (Route as unknown as { options: { component: ComponentType } }).options.component;
const kpi = (label: string) => screen.getByText(label).parentElement?.textContent ?? "";
const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const exportsDisabled = () =>
  [/Reconciled CSV/, /Raw events CSV/, /Print \/ PDF/, /Rescan selected week/].map(
    (n) => button(n).disabled,
  );
function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
  return screen.getByRole("tabpanel");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T15:00:00Z"));
  ports.weekCalls = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Driver Time weekly read lifecycle with the real handler payload", () => {
  it("success shows the honest lower bound, exports and sweep history for the selected week", () => {
    state({ data: loaded });
    render(<Page />);
    expect(ports.weekCalls[0]).toEqual(["2026-11-09", true, false]);
    expect(screen.getByText(/Week of Mon, Nov 9 – Fri, Nov 13/)).toBeTruthy();
    expect(kpi("Estimated cost")).toContain(FIGURE);
    expect(screen.getByText("Max Nopaycom")).toBeTruthy();
    expect(exportsDisabled()).toEqual([false, false, false, false]);
    expect(openTab("Sweeps").textContent).toMatch(/synthetic sweep note/);
    const settings = openTab("Settings");
    expect(settings.textContent).not.toMatch(/Estimated cost|At least|not costed/);
  });

  it("first load pending hides numbers, the report, exports and sweep history", () => {
    state({ isLoading: true, isFetching: true });
    render(<Page />);
    expect(screen.getAllByLabelText("Loading")).toHaveLength(4);
    expect(screen.queryByText(/At least|not costed|\$/)).toBeNull();
    expect(exportsDisabled()).toEqual([true, true, true, true]);
    expect(openTab("Sweeps").textContent).toMatch(/unavailable until this week loads/);
  });

  it("a failed refresh with cached data hides every stale number and report", () => {
    state({ isError: true, data: loaded, error: new Error("timeout") });
    render(<Page />);
    expect(screen.getByText(/Report unavailable: timeout/)).toBeTruthy();
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(4);
    expect(screen.queryByText(FIGURE)).toBeNull();
    expect(screen.queryByText("Max Nopaycom")).toBeNull();
    expect(screen.queryByText(/fully priced|not costed/)).toBeNull();
    expect(exportsDisabled()).toEqual([true, true, true, true]);
    expect(openTab("Sweeps").textContent).not.toMatch(/synthetic sweep note/);
  });

  it("retrying a failed week keeps cached numbers hidden", () => {
    state({ isError: true, isFetching: true, data: loaded, error: new Error("timeout") });
    render(<Page />);
    expect(screen.getAllByLabelText("Loading")).toHaveLength(4);
    expect(screen.queryByText(FIGURE)).toBeNull();
    expect(button(/^Retry$/).disabled).toBe(true);
    expect(exportsDisabled()).toEqual([true, true, true, true]);
  });

  it("a successful empty week may show zero counts without a cost", () => {
    state({ data: empty });
    render(<Page />);
    expect(kpi("Drivers in report")).toBe("Drivers in report0");
    expect(kpi("Estimated cost")).toBe("Estimated cost—");
    expect(screen.getByText(/does not prove zero hours/)).toBeTruthy();
    expect(openTab("Sweeps").textContent).toMatch(/synthetic sweep note/);
  });
});
