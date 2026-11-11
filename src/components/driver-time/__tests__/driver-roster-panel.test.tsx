// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";

type Payload = {
  active: Array<{ id: string; name: string; source: string }>;
  hidden: Array<{
    id: string;
    name: string;
    reason: "id";
    alsoMatchesPattern: boolean;
    hasRates: boolean;
  }>;
  settingsUpdatedAt: string | null;
  rosterError: string | null;
};

const before: Payload = {
  active: [
    { id: "100", name: "Avery Active", source: "roster" },
    { id: "200", name: "Evan Events", source: "events" },
  ],
  hidden: [
    { id: "900", name: "Harper Hidden", reason: "id", alsoMatchesPattern: false, hasRates: true },
  ],
  settingsUpdatedAt: "stamp-1",
  rosterError: null,
};

const afterHide: Payload = {
  active: [{ id: "200", name: "Evan Events", source: "events" }],
  hidden: [
    { id: "100", name: "Avery Active", reason: "id", alsoMatchesPattern: false, hasRates: false },
    ...before.hidden,
  ],
  settingsUpdatedAt: "stamp-2",
  rosterError: null,
};

const ports = vi.hoisted(() => ({
  roles: [] as string[],
  listCalls: vi.fn(),
  query: {
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null as Error | null,
    data: null as unknown,
    refetch: vi.fn(),
  },
  mutate: vi.fn(),
  pending: false,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ roles: ports.roles }),
}));
vi.mock("@/hooks/useDriverTime", () => ({
  useDriverRoster: (enabled: boolean) => {
    ports.listCalls(enabled);
    return ports.query;
  },
  useSetDriverRosterVisibility: () => ({ mutateAsync: ports.mutate, isPending: ports.pending }),
}));

import { DriverRosterPanel } from "../DriverRosterPanel";
import { ROSTER_CONFLICT_MESSAGE } from "@/lib/driver-time/roster";

function load(data: Payload, next?: Payload) {
  ports.query = {
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    data,
    refetch: vi.fn(async () => {
      if (next) ports.query.data = next;
      return { isSuccess: true, isError: false, data: ports.query.data };
    }),
  };
}

async function settle() {
  // Radix restores focus after unmount on a zero-delay timer.
  await act(() => new Promise((r) => setTimeout(r, 10)));
}

afterEach(() => {
  cleanup();
  ports.listCalls.mockClear();
  ports.mutate.mockReset();
  ports.pending = false;
});

describe("DriverRosterPanel role gate", () => {
  for (const roles of [
    [],
    ["ops_logistics"],
    ["branch_manager"],
    ["branch_manager", "ops_logistics_admin"],
    ["branch_manager", "admin"],
    ["ops_orders"],
  ]) {
    it(`renders and loads nothing for ${roles.join("+") || "unauthenticated"}`, () => {
      ports.roles = roles;
      load(before);
      const { container } = render(<DriverRosterPanel />);
      expect(container.innerHTML).toBe("");
      expect(ports.listCalls).not.toHaveBeenCalled();
    });
  }
  for (const roles of [
    ["admin"],
    ["ops_logistics_admin"],
    ["ops_logistics_admin", "ops_logistics"],
  ]) {
    it(`${roles.join("+")} sees the roster with Hide and Restore`, () => {
      ports.roles = roles;
      load(before);
      render(<DriverRosterPanel />);
      expect(screen.getByTestId("driver-roster-heading").textContent).toBe("Driver roster");
      expect(screen.getByRole("button", { name: "Hide Avery Active" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restore Harper Hidden" })).toBeTruthy();
      expect(screen.getByText(/Hidden drivers \(1\)/)).toBeTruthy();
      expect(ports.listCalls).toHaveBeenCalledWith(true);
      // No free-text add and no name-pattern editor here.
      expect(screen.queryByRole("button", { name: /add driver/i })).toBeNull();
      expect(screen.queryByText(/name pattern/i)).toBeNull();
      expect(screen.queryByRole("textbox", { name: /pattern/i })).toBeNull();
    });
  }
});

describe("DriverRosterPanel hide / restore", () => {
  it("Hide asks for confirmation; Cancel writes nothing and returns focus to Hide", async () => {
    ports.roles = ["ops_logistics_admin"];
    load(before);
    render(<DriverRosterPanel />);
    const hide = screen.getByRole("button", { name: "Hide Avery Active" });
    hide.focus();
    fireEvent.click(hide);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Hide Avery Active?")).toBeTruthy();
    expect(
      within(dialog).getByText(/rates, warehouse events and capacity history are kept/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(ports.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(hide);
  });

  it("Escape also cancels and returns focus to Hide", async () => {
    ports.roles = ["admin"];
    load(before);
    render(<DriverRosterPanel />);
    const hide = screen.getByRole("button", { name: "Hide Evan Events" });
    hide.focus();
    fireEvent.click(hide);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(ports.mutate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(hide);
  });

  it("confirmed Hide sends the token, announces, and focuses the new Restore button", async () => {
    ports.roles = ["ops_logistics_admin"];
    load(before, afterHide);
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-2" });
    render(<DriverRosterPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Avery Active" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide driver" }));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(ports.mutate).toHaveBeenCalledWith({
      driverId: "100",
      hidden: true,
      expectedUpdatedAt: "stamp-1",
    });
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Hid Avery Active. Their rates, events and history are kept.",
    );
    expect(screen.getByTestId("driver-roster-live").getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Restore Avery Active" }),
    );
  });

  it("Restore needs no dialog, announces, and focuses the driver's Hide button", async () => {
    ports.roles = ["admin"];
    load(afterHide, before);
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore Avery Active" }));
    });
    await settle();
    expect(ports.mutate).toHaveBeenCalledWith({
      driverId: "100",
      hidden: false,
      expectedUpdatedAt: "stamp-2",
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByTestId("driver-roster-live").textContent).toBe("Restored Avery Active.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide Avery Active" }));
  });

  it("Restore of someone Samsara no longer lists says when they will come back", async () => {
    ports.roles = ["admin"];
    const gone: Payload = { ...before, hidden: [] };
    load(before, { ...gone, active: before.active });
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore Harper Hidden" }));
    });
    await settle();
    expect(screen.getByTestId("driver-roster-live").textContent).toMatch(
      /Restored Harper Hidden\. They will reappear on the roster once Samsara lists them/,
    );
    expect(document.activeElement).toBe(screen.getByTestId("driver-roster-hidden-heading"));
  });

  it("an already-hidden driver is reported, not treated as an error", async () => {
    ports.roles = ["ops_logistics_admin"];
    load(before, afterHide);
    ports.mutate.mockResolvedValue({ ok: true, changed: false, updatedAt: "stamp-2" });
    render(<DriverRosterPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Avery Active" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide driver" }));
    });
    await settle();
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Avery Active was already hidden.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a conflict shows a clear message and Refresh list reloads and refocuses", async () => {
    ports.roles = ["ops_logistics_admin"];
    load(before);
    ports.mutate.mockRejectedValue(new Error(ROSTER_CONFLICT_MESSAGE));
    render(<DriverRosterPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Avery Active" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide driver" }));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/changed since you loaded it/);
    const refresh = screen.getByRole("button", { name: "Refresh list" });
    expect(document.activeElement).toBe(refresh);
    expect(ports.query.refetch).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(refresh);
    });
    await settle();
    expect(ports.query.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("driver-roster-live").textContent).toMatch(/Driver list refreshed/);
    expect(document.activeElement).toBe(screen.getByTestId("driver-roster-heading"));
  });

  it("a non-conflict failure keeps focus on the opener and shows no Refresh button", async () => {
    ports.roles = ["admin"];
    load(before);
    ports.mutate.mockRejectedValue(new Error("Driver pay access required"));
    render(<DriverRosterPanel />);
    const hide = screen.getByRole("button", { name: "Hide Avery Active" });
    fireEvent.click(hide);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide driver" }));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/Driver pay access required/);
    expect(screen.queryByRole("button", { name: "Refresh list" })).toBeNull();
    expect(document.activeElement).toBe(hide);
  });

  it("filter narrows both lists by name or id", () => {
    ports.roles = ["admin"];
    load(before);
    render(<DriverRosterPanel />);
    fireEvent.change(screen.getByLabelText("Filter roster"), { target: { value: "evan" } });
    expect(screen.queryByRole("button", { name: "Hide Avery Active" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide Evan Events" })).toBeTruthy();
    expect(screen.getByText("No hidden drivers match this filter.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter roster"), { target: { value: "900" } });
    expect(screen.getByRole("button", { name: "Restore Harper Hidden" })).toBeTruthy();
  });

  it("flags a hidden driver that a name pattern would still hide", () => {
    ports.roles = ["admin"];
    load({ ...before, hidden: [{ ...before.hidden[0], alsoMatchesPattern: true }] });
    render(<DriverRosterPanel />);
    expect(screen.getByText(/Restore alone will not bring them back/)).toBeTruthy();
  });
});
