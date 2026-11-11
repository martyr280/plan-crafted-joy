// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

const week = {
  weekStart: "2026-11-09",
  weekEnd: "2026-11-15",
  isAdmin: false,
  canManageDriverPay: true,
  thresholdMinutes: 90,
  drivers: [
    {
      driverId: "d1",
      driverName: "Synthetic Driver",
      hub: "Dallas",
      flaggedMinutes: 30,
      automatedMinutes: 30,
      officialMinutes: 0,
      varianceMinutes: 30,
      official: null,
      cost: { cost: null, note: "No rate" },
      history: [],
      events: [],
    },
  ],
  hubGroups: [{ hub: "Dallas", drivers: [], flaggedMinutes: 30 }],
  totals: {
    drivers: 1,
    flaggedMinutes: 30,
    needsReview: 1,
    officialDrivers: 0,
    estimatedCost: 0,
    driversWithoutRate: 1,
  },
  runs: [],
};

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/usage-log", () => ({ useModuleView: () => {} }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    roles: ["ops_logistics_admin"],
    hasRole: (role: string) => role === "ops_logistics_admin",
  }),
}));
vi.mock("@/hooks/useDriverTime", () => ({
  useDriverTimeWeek: () => ({
    isLoading: false,
    isError: false,
    isFetching: false,
    data: week,
    error: null,
    refetch: vi.fn(),
  }),
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
  useDriverRoster: () => ({
    isLoading: false,
    isError: false,
    data: { active: [], hidden: [], settingsUpdatedAt: null, rosterError: null },
    refetch: vi.fn(),
  }),
  useSetDriverRosterVisibility: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { Route } from "@/routes/_app.driver-time";

afterEach(() => cleanup());

describe("Driver Time tabs", () => {
  it("keeps the weekly report inside the Weekly tab", () => {
    const Page = (Route as { options: { component: React.ComponentType } }).options.component;
    render(<Page />);
    expect(screen.getByText("Drivers in report")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Settings" }), {
      button: 0,
      ctrlKey: false,
    });
    const settings = screen.getByRole("tabpanel");
    expect(settings.textContent).not.toMatch(/Drivers in report/);
    expect(settings.textContent).not.toMatch(/Needs review/);
    expect(settings.textContent).toMatch(/Detection/);
    expect(screen.getByTestId("driver-roster-heading").textContent).toBe("Driver roster");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Sweeps" }), {
      button: 0,
      ctrlKey: false,
    });
    const sweeps = screen.getByRole("tabpanel");
    expect(sweeps.textContent).not.toMatch(/Drivers in report/);
    expect(sweeps.textContent).toMatch(/No sweeps yet/);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Weekly report" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("tabpanel").textContent).toMatch(/Drivers in report/);
  });
});
