// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const emptyData = {
  drivers: [] as { id: string; name: string; source: string }[],
  rates: [] as {
    id: string;
    driver_id: string;
    hourly_rate: number;
    effective_date: string;
    updated_at: string;
  }[],
  rosterError: null as string | null,
};

const loaded = {
  drivers: [{ id: "d1", name: "Synthetic Driver", source: "roster" }],
  rates: [
    {
      id: "r1",
      driver_id: "d1",
      hourly_rate: 20,
      effective_date: "2026-01-05",
      updated_at: "stamp-1",
    },
  ],
  rosterError: null,
};

const ports = vi.hoisted(() => ({
  roles: [] as string[],
  listCalls: vi.fn(),
  query: {
    isLoading: false,
    isError: false,
    error: null as Error | null,
    data: null as unknown,
    refetch: vi.fn(),
  },
  add: vi.fn(),
  update: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    roles: ports.roles,
    hasAnyRole: (rs: string[]) => rs.some((r) => ports.roles.includes(r)),
  }),
}));
vi.mock("@/hooks/useDriverTime", () => ({
  useDriverPayRates: (enabled: boolean) => {
    ports.listCalls(enabled);
    return ports.query;
  },
  useAddDriverPayRate: () => ({ mutateAsync: ports.add, isPending: false }),
  useUpdateDriverPayRate: () => ({ mutateAsync: ports.update, isPending: false }),
}));

import { DriverRatesPanel } from "../DriverRatesPanel";
import { toast } from "sonner";

function showLoaded() {
  ports.query = { isLoading: false, isError: false, error: null, data: loaded, refetch: vi.fn() };
}

afterEach(() => {
  cleanup();
  ports.listCalls.mockClear();
  ports.add.mockReset();
  ports.update.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("DriverRatesPanel role matrix", () => {
  for (const roles of [
    [],
    ["ops_logistics"],
    ["branch_manager"],
    ["sales_rep"],
    ["ops_orders"],
    ["admin", "branch_manager"],
    ["ops_logistics_admin", "branch_manager"],
  ]) {
    it(`hidden and loads no rates for ${roles.join("+") || "unauthenticated"}`, () => {
      ports.roles = roles;
      showLoaded();
      const { container } = render(<DriverRatesPanel />);
      expect(container.innerHTML).toBe("");
      expect(screen.queryByText(/\$20\.00/)).toBeNull();
      expect(screen.queryByText("Synthetic Driver")).toBeNull();
      expect(ports.listCalls).not.toHaveBeenCalled();
    });
  }
  for (const roles of [
    ["admin"],
    ["ops_logistics_admin"],
    ["ops_logistics_admin", "ops_logistics", "ops_orders"],
  ]) {
    it(`${roles.join("+")} sees Driver rates with the current amount`, () => {
      ports.roles = roles;
      showLoaded();
      render(<DriverRatesPanel />);
      expect(screen.getByTestId("driver-rates-heading").textContent).toBe("Driver rates");
      expect(screen.getByText("Synthetic Driver")).toBeTruthy();
      expect(screen.getByText("$20.00/hr")).toBeTruthy();
      expect(screen.getByText(/since 2026-01-05/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
      expect(ports.listCalls).toHaveBeenCalledWith(true);
    });
  }
});

describe("DriverRatesPanel states", () => {
  it("empty roster", () => {
    ports.roles = ["ops_logistics_admin"];
    ports.query = {
      isLoading: false,
      isError: false,
      error: null,
      data: emptyData,
      refetch: vi.fn(),
    };
    render(<DriverRatesPanel />);
    expect(screen.getByText("No drivers on the roster yet.")).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
  it("loading hides amounts", () => {
    ports.roles = ["admin"];
    ports.query = {
      isLoading: true,
      isError: false,
      error: null,
      data: undefined,
      refetch: vi.fn(),
    };
    render(<DriverRatesPanel />);
    expect(screen.getByText(/Loading rates/)).toBeTruthy();
    expect(screen.queryByText("Synthetic Driver")).toBeNull();
    expect(screen.queryByText(/\$20\.00/)).toBeNull();
  });
  it("error hides amounts", () => {
    ports.roles = ["ops_logistics_admin"];
    ports.query = {
      isLoading: false,
      isError: true,
      error: new Error("denied by policy"),
      data: undefined,
      refetch: vi.fn(),
    };
    render(<DriverRatesPanel />);
    expect(screen.getByText(/Rates unavailable: denied by policy/)).toBeTruthy();
    expect(screen.queryByText(/\$20\.00/)).toBeNull();
    expect(screen.queryByText("Synthetic Driver")).toBeNull();
  });
  it("history lists the effective date and a future row", () => {
    ports.roles = ["admin"];
    ports.query = {
      isLoading: false,
      isError: false,
      error: null,
      data: {
        drivers: loaded.drivers,
        rates: [
          ...loaded.rates,
          {
            id: "r2",
            driver_id: "d1",
            hourly_rate: 30,
            effective_date: "2099-01-01",
            updated_at: "stamp-2",
          },
        ],
        rosterError: null,
      },
      refetch: vi.fn(),
    };
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(screen.getByText("2099-01-01")).toBeTruthy();
    expect(screen.getByText("Starts later")).toBeTruthy();
    expect(screen.getByText("$30.00/hr")).toBeTruthy();
  });
  it("invalid rate and a future effective date", () => {
    ports.roles = ["ops_logistics_admin"];
    showLoaded();
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add rate for Synthetic Driver/ }));
    const amount = screen.getByLabelText("Hourly rate (USD)");
    fireEvent.change(amount, { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toMatch(/more than \$0/);
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(amount.getAttribute("aria-describedby")).toBe("rate-error");
    const dateInput = screen.getByLabelText("Effective date");
    expect(dateInput.getAttribute("aria-invalid")).toBe("false");
    expect(dateInput.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(amount, { target: { value: "24.505" } });
    expect(screen.getByRole("alert").textContent).toMatch(/2 decimals/);
    fireEvent.change(amount, { target: { value: "24.50" } });
    expect(amount.getAttribute("aria-invalid")).toBe("false");
    fireEvent.change(dateInput, { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Pick an effective date/);
    expect(dateInput.getAttribute("aria-invalid")).toBe("true");
    expect(dateInput.getAttribute("aria-describedby")).toBe("date-error");
    expect(amount.getAttribute("aria-describedby")).toBeNull();
    fireEvent.change(dateInput, { target: { value: "2026-11-10" } });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2099-06-01" } });
    expect(screen.getByText(/Future date: applies from 2099-06-01/)).toBeTruthy();
  });
  it("duplicate effective date is shown and does not clear the form silently", async () => {
    ports.roles = ["admin"];
    showLoaded();
    ports.add.mockRejectedValue(
      new Error("This driver already has a rate starting 2026-11-10. Edit that row instead."),
    );
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add rate for Synthetic Driver/ }));
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "18.00" } });
    fireEvent.change(screen.getByLabelText("Effective date"), { target: { value: "2026-11-10" } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Add rate" }).at(-1)!);
    });
    expect(ports.add).toHaveBeenCalledWith({
      driverId: "d1",
      driverName: "Synthetic Driver",
      hourlyRate: 18,
      effectiveDate: "2026-11-10",
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringMatching(/already has a rate starting 2026-11-10/),
    );
  });
  it("stale update tells the editor to refresh", async () => {
    ports.roles = ["ops_logistics_admin"];
    showLoaded();
    ports.update.mockRejectedValue(
      new Error("This rate changed since you opened it. Refresh and try again."),
    );
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Edit rate for Synthetic Driver from 2026-01-05/ }),
    );
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "21.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    expect(ports.update).toHaveBeenCalledWith({
      id: "r1",
      hourlyRate: 21,
      effectiveDate: "2026-01-05",
      expectedUpdatedAt: "stamp-1",
    });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      expect.stringMatching(/changed since you opened it/),
    );
  });

  it("a successful refresh moves the shown baseline and the save token together", async () => {
    ports.roles = ["admin"];
    showLoaded();
    ports.update.mockRejectedValueOnce(
      new Error("This rate changed since you opened it. Refresh and try again."),
    );
    ports.query.refetch = vi.fn().mockResolvedValue({
      isSuccess: true,
      isError: false,
      data: {
        ...loaded,
        rates: [{ ...loaded.rates[0], hourly_rate: 25, updated_at: "stamp-2" }],
      },
    });
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Edit rate for Synthetic Driver from 2026-01-05/ }),
    );
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "21.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh this rate" }));
    });
    expect(screen.getByRole("status").textContent).toMatch(/\$25\.00\/hr from 2026-01-05/);
    expect(screen.getByRole("status").textContent).toMatch(/\$21\.00\/hr from 2026-01-05/);
    expect(document.activeElement).toBe(screen.getByRole("status"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    expect(ports.update).toHaveBeenLastCalledWith({
      id: "r1",
      hourlyRate: 21,
      effectiveDate: "2026-01-05",
      expectedUpdatedAt: "stamp-2",
    });
  });

  it("a failed or missing refresh keeps the stale error and the original token", async () => {
    ports.roles = ["ops_logistics_admin"];
    showLoaded();
    ports.update.mockRejectedValue(
      new Error("This rate changed since you opened it. Refresh and try again."),
    );
    let rejectRefresh: (error: Error) => void = () => undefined;
    ports.query.refetch = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Edit rate for Synthetic Driver from 2026-01-05/ }),
    );
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "21.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh this rate" }));
    expect(screen.getByRole("status").textContent).toMatch(/Refreshing this rate/);
    expect((screen.getByLabelText("Hourly rate (USD)") as HTMLInputElement).value).toBe("21.00");
    await act(async () => {
      rejectRefresh(new Error("network"));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/changed since you opened it/);
    expect(screen.getByRole("status").textContent).toMatch(/Could not refresh this rate/);
    expect(screen.queryByText(/\$25\.00/)).toBeNull();
    ports.query.refetch = vi.fn().mockResolvedValue({
      isSuccess: true,
      isError: false,
      data: { drivers: loaded.drivers, rates: [], rosterError: null },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh this rate" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/changed since you opened it/);
    expect(screen.getByRole("status").textContent).toMatch(/not in the refreshed list/);
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    expect(ports.update).toHaveBeenLastCalledWith({
      id: "r1",
      hourlyRate: 21,
      effectiveDate: "2026-01-05",
      expectedUpdatedAt: "stamp-1",
    });
  });

  it("ignores a second refresh while the first is still pending", async () => {
    ports.roles = ["ops_logistics_admin"];
    showLoaded();
    ports.update.mockRejectedValue(
      new Error("This rate changed since you opened it. Refresh and try again."),
    );
    let rejectRefresh: (error: Error) => void = () => undefined;
    ports.query.refetch = vi.fn().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Edit rate for Synthetic Driver from 2026-01-05/ }),
    );
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "21.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    const refresh = screen.getByRole("button", { name: "Refresh this rate" });
    fireEvent.click(refresh);
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(refresh);
    expect(ports.query.refetch).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Hourly rate (USD)") as HTMLInputElement).value).toBe("21.00");
    await act(async () => {
      rejectRefresh(new Error("network"));
    });
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/changed since you opened it/);
    expect(screen.getByRole("status").textContent).toMatch(/Could not refresh this rate/);
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    expect(ports.update).toHaveBeenLastCalledWith({
      id: "r1",
      hourlyRate: 21,
      effectiveDate: "2026-01-05",
      expectedUpdatedAt: "stamp-1",
    });
  });

  it("keeps the conflict when refetch resolves with an error and cached rates", async () => {
    ports.roles = ["admin"];
    showLoaded();
    ports.update.mockRejectedValue(
      new Error("This rate changed since you opened it. Refresh and try again."),
    );
    ports.query.refetch = vi.fn().mockResolvedValue({
      isError: true,
      isSuccess: false,
      error: new Error("timeout"),
      data: {
        ...loaded,
        rates: [{ ...loaded.rates[0], hourly_rate: 25, updated_at: "stamp-2" }],
      },
    });
    render(<DriverRatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    fireEvent.click(
      screen.getByRole("button", { name: /Edit rate for Synthetic Driver from 2026-01-05/ }),
    );
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "21.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh this rate" }));
    });
    expect((screen.getByLabelText("Hourly rate (USD)") as HTMLInputElement).value).toBe("21.00");
    expect(screen.getByRole("alert").textContent).toMatch(/changed since you opened it/);
    expect(screen.getByRole("status").textContent).toMatch(/Could not refresh this rate/);
    expect(screen.queryByText(/\$25\.00/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
    expect(ports.update).toHaveBeenLastCalledWith({
      id: "r1",
      hourlyRate: 21,
      effectiveDate: "2026-01-05",
      expectedUpdatedAt: "stamp-1",
    });
  });
});

describe("DriverRatesPanel focus return", () => {
  const addName = /Add rate for Synthetic Driver/;
  const editName = /Edit rate for Synthetic Driver from 2026-01-05/;

  // Keyboard activation: the opener holds focus when it is clicked.
  function open(name: RegExp) {
    if (name === editName) fireEvent.click(screen.getByRole("button", { name: /History/ }));
    const opener = screen.getByRole("button", { name });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    return opener;
  }

  async function closed() {
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Radix restores focus after unmount on a zero-delay timer.
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }

  function escape() {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  }

  async function edit() {
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "21.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    });
  }

  for (const [label, name] of [
    ["Add", addName],
    ["Edit", editName],
  ] as const) {
    it(`${label}: Escape returns focus to the opener`, async () => {
      ports.roles = ["admin"];
      showLoaded();
      render(<DriverRatesPanel />);
      const opener = open(name);
      escape();
      await closed();
      expect(document.activeElement).toBe(opener);
    });

    it(`${label}: Cancel returns focus to the opener`, async () => {
      ports.roles = ["admin"];
      showLoaded();
      render(<DriverRatesPanel />);
      const opener = open(name);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await closed();
      expect(document.activeElement).toBe(opener);
    });
  }

  it("Add: a successful save returns focus to the opener", async () => {
    ports.roles = ["ops_logistics_admin"];
    showLoaded();
    ports.add.mockResolvedValue({ ok: true });
    render(<DriverRatesPanel />);
    const opener = open(addName);
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "22.00" } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Add rate" }).at(-1)!);
    });
    await closed();
    expect(ports.add).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("Edit: a successful save returns focus to the opener", async () => {
    ports.roles = ["ops_logistics_admin"];
    showLoaded();
    ports.update.mockResolvedValue({ ok: true });
    render(<DriverRatesPanel />);
    const opener = open(editName);
    await edit();
    await closed();
    expect(ports.update).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("falls back to the Driver rates heading when the opener is gone after a save", async () => {
    ports.roles = ["admin"];
    showLoaded();
    ports.update.mockImplementation(async () => {
      ports.query = {
        ...ports.query,
        data: { ...loaded, rates: [{ ...loaded.rates[0], id: "r1-replaced" }] },
      };
      return { ok: true };
    });
    render(<DriverRatesPanel />);
    const opener = open(editName);
    await edit();
    await closed();
    expect(opener.isConnected).toBe(false);
    const heading = screen.getByTestId("driver-rates-heading");
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("a failed save keeps the dialog open with focus inside it", async () => {
    ports.roles = ["admin"];
    showLoaded();
    ports.add.mockRejectedValue(new Error("Could not save the rate"));
    render(<DriverRatesPanel />);
    open(addName);
    fireEvent.change(screen.getByLabelText("Hourly rate (USD)"), { target: { value: "22.00" } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Add rate" }).at(-1)!);
    });
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
