// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const cfg = vi.hoisted(() => ({ mutate: vi.fn(), refetch: vi.fn() }));

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
    data: {
      settings: { warehouseAddressIds: [], thresholdMinutes: 90 },
      drivers: [],
      error: null,
      settingsUpdatedAt: "settings-stamp-1",
    },
    refetch: cfg.refetch,
  }),
  useSaveDriverTimeConfig: () => ({ mutate: cfg.mutate, isPending: false }),
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
import { SETTINGS_CONFLICT_MESSAGE } from "@/lib/driver-time/roster";

afterEach(() => {
  cleanup();
  cfg.mutate.mockReset();
  cfg.refetch.mockReset();
});

function openSettings() {
  const Page = (Route as { options: { component: React.ComponentType } }).options.component;
  render(<Page />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Settings" }), { button: 0, ctrlKey: false });
}

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

  it("Detection save sends the settings token and never the hidden-driver lists", () => {
    openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Save detection settings" }));
    expect(cfg.mutate).toHaveBeenCalledOnce();
    const patch = cfg.mutate.mock.calls[0][0];
    expect(patch.expectedUpdatedAt).toBe("settings-stamp-1");
    expect(patch).not.toHaveProperty("excludedDriverIds");
    expect(patch).not.toHaveProperty("excludedDrivers");
  });

  async function openDetectionConflict() {
    cfg.mutate.mockImplementation((_patch, opts) =>
      opts.onError(new Error(SETTINGS_CONFLICT_MESSAGE)),
    );
    openSettings();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save detection settings" }));
    });
    expect(screen.getByTestId("detection-conflict").getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("detection-conflict").textContent).toMatch(
      /changed since you loaded them/,
    );
    const refresh = screen.getByRole("button", { name: "Refresh settings" });
    refresh.focus();
    return refresh;
  }

  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const fresh = { isError: false, data: { settings: {}, settingsUpdatedAt: "settings-stamp-2" } };

  it("Detection Refresh keeps the alert while pending, blocks duplicates, and focuses the heading on success", async () => {
    const refresh = await openDetectionConflict();
    const read = deferred<unknown>();
    cfg.refetch.mockImplementation(() => read.promise);
    fireEvent.click(refresh);
    await act(async () => {});
    expect(screen.getByTestId("detection-conflict")).toBeTruthy();
    expect(refresh.isConnected).toBe(true);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    expect(screen.getByTestId("detection-progress").textContent).toBe("Refreshing settings…");
    fireEvent.click(refresh);
    expect(cfg.refetch).toHaveBeenCalledOnce();
    await act(async () => read.resolve(fresh));
    expect(screen.queryByTestId("detection-conflict")).toBeNull();
    const result = screen.getByTestId("detection-refresh-result");
    expect(result.textContent).toBe("Settings refreshed. Review them and save again.");
    expect(result.className).not.toMatch(/sr-only/);
    expect(document.activeElement).toBe(screen.getByTestId("detection-heading"));
  });

  it("Detection Refresh failure keeps the conflict and a focused retry, and announces the error", async () => {
    const refresh = await openDetectionConflict();
    const read = deferred<unknown>();
    cfg.refetch.mockImplementation(() => read.promise);
    fireEvent.click(refresh);
    refresh.blur();
    await act(async () => read.resolve({ isError: true, data: undefined }));
    expect(screen.getByTestId("detection-conflict")).toBeTruthy();
    expect(screen.getByTestId("detection-refresh-error").textContent).toBe(
      "Couldn't refresh the settings. Try Refresh settings again.",
    );
    expect(screen.getByTestId("detection-progress").textContent).toBe(
      "Couldn't refresh the settings. Try Refresh settings again.",
    );
    expect(refresh.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(refresh);
    expect(screen.getByTestId("detection-refresh-result").textContent).toBe("");

    cfg.refetch.mockResolvedValue(fresh);
    await act(async () => {
      fireEvent.click(refresh);
    });
    expect(cfg.refetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("detection-conflict")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("detection-heading"));
  });

  it("Detection Refresh does not steal focus from a field the user moved to", async () => {
    const refresh = await openDetectionConflict();
    const read = deferred<unknown>();
    cfg.refetch.mockImplementation(() => read.promise);
    fireEvent.click(refresh);
    const field = screen.getAllByRole("textbox")[0];
    field.focus();
    fireEvent.keyDown(field, { key: "9" });
    await act(async () => read.resolve(fresh));
    expect(screen.queryByTestId("detection-conflict")).toBeNull();
    expect(document.activeElement).toBe(field);
  });
});
