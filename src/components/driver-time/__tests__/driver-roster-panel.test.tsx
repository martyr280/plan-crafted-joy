// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";

type Payload = {
  active: Array<{ id: string; name: string; source: string }>;
  hidden: Array<{
    id: string;
    name: string;
    reason: "id";
    hiddenFrom: string | null;
    alsoMatchesPattern: boolean;
    hasRates: boolean;
  }>;
  patternMatchedIds?: string[];
  settingsUpdatedAt: string | null;
  rosterError: string | null;
};

const before: Payload = {
  active: [
    { id: "100", name: "Avery Active", source: "roster" },
    { id: "200", name: "Evan Events", source: "events" },
  ],
  hidden: [
    {
      id: "900",
      name: "Harper Hidden",
      reason: "id",
      hiddenFrom: null,
      alsoMatchesPattern: false,
      hasRates: true,
    },
  ],
  settingsUpdatedAt: "stamp-1",
  rosterError: null,
};

const afterHide: Payload = {
  active: [{ id: "200", name: "Evan Events", source: "events" }],
  hidden: [
    {
      id: "100",
      name: "Avery Active",
      reason: "id",
      hiddenFrom: "2026-11-09",
      alsoMatchesPattern: false,
      hasRates: false,
    },
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

beforeEach(() => {
  // Wednesday Nov 11, 2026 in Central time; the hide week starts Mon Nov 9.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T17:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(dialog.textContent).toMatch(
      /from the week of Nov 9, 2026 onward\. Earlier weeks keep their time and estimated cost\./,
    );
    expect(dialog.textContent).not.toMatch(/past weeks/);
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
    ports.mutate.mockResolvedValue({
      ok: true,
      changed: true,
      updatedAt: "stamp-2",
      hiddenFrom: "2026-11-09",
    });
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
      "Hid Avery Active from the week of Nov 9, 2026 onward. Earlier weeks still include them, and their rates, events and history are kept.",
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
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Removed the hide for Avery Active. They are back on the roster.",
    );
    expect(screen.getByTestId("driver-roster-live").className).not.toMatch(/sr-only/);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide Avery Active" }));
  });

  it("Restore of someone not in the refreshed roster gives neutral guidance, not a reason", async () => {
    ports.roles = ["admin"];
    const gone: Payload = { ...before, hidden: [] };
    load(before, { ...gone, active: before.active });
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore Harper Hidden" }));
    });
    await settle();
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Removed the hide for Harper Hidden, but they are not shown in the refreshed roster. Check Detection rules and Samsara driver status.",
    );
    expect(screen.getByTestId("driver-roster-live").textContent).not.toMatch(
      /no events or rates|licensed|active driver/,
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
    expect(
      screen.getByText(
        "Hidden in all weeks — matches a name rule in Detection. Restore removes the hide set here, but the name rule must also be changed before the driver can return.",
      ),
    ).toBeTruthy();
  });

  it("labels older all-week hides and dated hides", () => {
    ports.roles = ["admin"];
    load(afterHide);
    render(<DriverRosterPanel />);
    const labels = screen.getAllByTestId("driver-roster-hidden-label").map((l) => l.textContent);
    expect(labels).toEqual([
      "Hidden from the week of Nov 9, 2026 (Central Time).",
      "Hidden in all weeks — older hide.",
    ]);
  });

  it("a dated hide that also matches a name rule is labelled all weeks, with the hide start secondary", () => {
    ports.roles = ["admin"];
    load({
      ...before,
      hidden: [{ ...afterHide.hidden[0], alsoMatchesPattern: true }],
    });
    render(<DriverRosterPanel />);
    const list = screen.getByRole("list", { name: "Hidden drivers" });
    expect(within(list).getByTestId("driver-roster-hidden-label").textContent).toMatch(
      /^Hidden in all weeks — matches a name rule in Detection\./,
    );
    expect(
      within(list).getByText("Hide set here starts the week of Nov 9, 2026 (Central Time)."),
    ).toBeTruthy();
    expect(list.textContent).not.toMatch(/Hidden from the week/);
  });

  it("the intro states the dated rule and what Restore can and cannot undo", () => {
    ports.roles = ["admin"];
    load(before);
    render(<DriverRosterPanel />);
    expect(screen.getByTestId("driver-roster-intro").textContent?.replace(/\s+/g, " ")).toBe(
      "Drivers come from Samsara, saved warehouse events and pay rates. A new hide starts on Monday of the current Central Time week and excludes the driver from that week and later reports and estimated costs. It does not change earlier weeks. Older hides and name rules can exclude all weeks. Stored rates, events and history are kept. Restore removes the hide set here; a matching name rule must be changed separately in Detection.",
    );
  });

  for (const name of ["Enyi Ukairo", "Scott Smith"]) {
    it(`Restore of ${name} while a name pattern still matches says the pattern keeps them hidden`, async () => {
      ports.roles = ["admin"];
      const hiddenByBoth: Payload = {
        ...before,
        hidden: [
          {
            id: "55",
            name,
            reason: "id",
            hiddenFrom: null,
            alsoMatchesPattern: true,
            hasRates: false,
          },
        ],
      };
      // After Restore the id hide is gone; the fresh read verifies the name rule still matches.
      load(hiddenByBoth, { ...before, hidden: [], patternMatchedIds: ["55"] });
      ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
      render(<DriverRosterPanel />);
      expect(screen.getByText(/matches a name rule in Detection/)).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `Restore ${name}` }));
      });
      await settle();
      const live = screen.getByTestId("driver-roster-live").textContent ?? "";
      expect(live).toBe(
        `Removed the hide set here for ${name}. A name rule in Detection still excludes them from all weeks. Change that rule before they can return.`,
      );
      expect(live).not.toMatch(/Samsara/);
      expect(screen.getByTestId("driver-roster-live").className).not.toMatch(/sr-only/);
    });

    it(`Restore of ${name} once the pattern is gone brings them back`, async () => {
      ports.roles = ["admin"];
      const legacyOnly: Payload = {
        ...before,
        hidden: [
          {
            id: "55",
            name,
            reason: "id",
            hiddenFrom: null,
            alsoMatchesPattern: false,
            hasRates: false,
          },
        ],
      };
      load(legacyOnly, {
        ...before,
        active: [...before.active, { id: "55", name, source: "events" }],
        hidden: [],
      });
      ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
      render(<DriverRosterPanel />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `Restore ${name}` }));
      });
      await settle();
      expect(screen.getByTestId("driver-roster-live").textContent).toBe(
        `Removed the hide for ${name}. They are back on the roster.`,
      );
      expect(document.activeElement).toBe(screen.getByRole("button", { name: `Hide ${name}` }));
    });
  }
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const harperBack: Payload = {
  ...before,
  active: [...before.active, { id: "900", name: "Harper Hidden", source: "rates" }],
  hidden: [],
};

describe("DriverRosterPanel verified results", () => {
  it("write succeeds but the refresh fails: visibility is unverified, never 'no events or rates'", async () => {
    ports.roles = ["admin"];
    load(before);
    // Harper has known rate history; the refetch fails and returns stale cached data.
    expect(before.hidden[0].hasRates).toBe(true);
    ports.query.refetch = vi.fn(async () => ({ isError: true, data: before }));
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore Harper Hidden" }));
    });
    await settle();
    const live = screen.getByTestId("driver-roster-live");
    expect(live.textContent).toBe(
      "Removed the hide for Harper Hidden. Couldn't refresh the driver list, so their current visibility is unverified. Refresh the list to check.",
    );
    expect(live.textContent).not.toMatch(/no events or rates|licensed|active driver|name rule/);
    expect(live.className).not.toMatch(/sr-only/);
    const refresh = screen.getByTestId("driver-roster-status-refresh");
    expect(refresh.textContent).toBe("Refresh list");
    expect(document.activeElement).toBe(refresh);

    ports.query.refetch = vi.fn(async () => {
      ports.query.data = harperBack;
      return { isError: false, data: harperBack };
    });
    await act(async () => {
      fireEvent.click(refresh);
    });
    await settle();
    expect(live.textContent).toBe(
      "Removed the hide for Harper Hidden. They are back on the roster.",
    );
    expect(screen.queryByTestId("driver-roster-status-refresh")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide Harper Hidden" }));
  });

  it("a successful refresh that does not list them, with no verified rule, stays neutral", async () => {
    ports.roles = ["admin"];
    load(before, { ...before, hidden: [], rosterError: "Samsara timeout", patternMatchedIds: [] });
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore Harper Hidden" }));
    });
    await settle();
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Removed the hide for Harper Hidden, but they are not shown in the refreshed roster. Check Detection rules and Samsara driver status.",
    );
  });

  it("uses the fresh read, not stale row metadata, to say a name rule still applies", async () => {
    ports.roles = ["admin"];
    // Row was loaded without a pattern match; the fresh read verifies one.
    load(before, { ...before, hidden: [], patternMatchedIds: ["900"] });
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore Harper Hidden" }));
    });
    await settle();
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Removed the hide set here for Harper Hidden. A name rule in Detection still excludes them from all weeks. Change that rule before they can return.",
    );
  });
});

describe("DriverRosterPanel action focus", () => {
  it("deferred Restore: trigger unmounts (focus on BODY), focus recovers to the moved Hide button", async () => {
    ports.roles = ["admin"];
    load(before);
    const read = deferred<unknown>();
    ports.query.refetch = vi.fn(() => read.promise);
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    const restore = screen.getByRole("button", { name: "Restore Harper Hidden" });
    restore.focus();
    fireEvent.click(restore);
    await act(async () => {});
    // Native disable during the write drops focus in browsers.
    restore.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      ports.query.data = harperBack;
      read.resolve({ isError: false, data: harperBack });
    });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide Harper Hidden" }));
  });

  it("deferred Restore: typing in the filter while it settles keeps focus in the filter", async () => {
    ports.roles = ["admin"];
    load(before);
    const read = deferred<unknown>();
    ports.query.refetch = vi.fn(() => read.promise);
    ports.mutate.mockResolvedValue({ ok: true, changed: true, updatedAt: "stamp-3" });
    render(<DriverRosterPanel />);
    const restore = screen.getByRole("button", { name: "Restore Harper Hidden" });
    restore.focus();
    fireEvent.click(restore);
    await act(async () => {});
    const filter = screen.getByLabelText("Filter roster") as HTMLInputElement;
    filter.focus();
    fireEvent.keyDown(filter, { key: "H" });
    fireEvent.change(filter, { target: { value: "Harper" } });
    await act(async () => {
      ports.query.data = harperBack;
      read.resolve({ isError: false, data: harperBack });
    });
    await settle();
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe("Harper");
    expect(screen.getByTestId("driver-roster-live").textContent).toMatch(/back on the roster/);
  });

  async function openConflict() {
    ports.mutate.mockRejectedValue(new Error(ROSTER_CONFLICT_MESSAGE));
    render(<DriverRosterPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Avery Active" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Hide driver" }));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await settle();
    const refresh = screen.getByRole("button", { name: "Refresh list" });
    expect(document.activeElement).toBe(refresh);
    return refresh;
  }

  it("conflict Refresh: stays mounted while pending, blocks duplicates, failure keeps a retry target", async () => {
    ports.roles = ["admin"];
    load(before);
    const refresh = await openConflict();
    const read = deferred<unknown>();
    ports.query.refetch = vi.fn(() => read.promise);
    fireEvent.click(refresh);
    await act(async () => {});
    expect(refresh.isConnected).toBe(true);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("driver-roster-progress").textContent).toBe(
      "Refreshing the driver list…",
    );
    fireEvent.click(refresh);
    expect(ports.query.refetch).toHaveBeenCalledOnce();
    refresh.blur();
    await act(async () => read.resolve({ isError: true, data: before }));
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/changed since you loaded it/);
    expect(screen.getByTestId("driver-roster-refresh-error").textContent).toBe(
      "Couldn't refresh the driver list. Try Refresh list again.",
    );
    expect(refresh.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(refresh);
  });

  it("conflict Refresh success: the alert unmounts (BODY) and focus moves to the roster heading", async () => {
    ports.roles = ["admin"];
    load(before);
    const refresh = await openConflict();
    const read = deferred<unknown>();
    ports.query.refetch = vi.fn(() => read.promise);
    fireEvent.click(refresh);
    await act(async () => read.resolve({ isError: false, data: before }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("driver-roster-live").textContent).toBe(
      "Driver list refreshed. Review it and try again.",
    );
    expect(document.activeElement).toBe(screen.getByTestId("driver-roster-heading"));
  });

  it("conflict Refresh: typing in the filter during the read keeps focus there", async () => {
    ports.roles = ["admin"];
    load(before);
    const refresh = await openConflict();
    const read = deferred<unknown>();
    ports.query.refetch = vi.fn(() => read.promise);
    fireEvent.click(refresh);
    const filter = screen.getByLabelText("Filter roster") as HTMLInputElement;
    filter.focus();
    fireEvent.change(filter, { target: { value: "Evan" } });
    await act(async () => read.resolve({ isError: false, data: before }));
    await settle();
    expect(document.activeElement).toBe(filter);
  });

  it("passive background reads never move focus", async () => {
    ports.roles = ["admin"];
    load(before);
    const { rerender } = render(<DriverRosterPanel />);
    const filter = screen.getByLabelText("Filter roster");
    filter.focus();
    ports.query = { ...ports.query, data: afterHide };
    rerender(<DriverRosterPanel />);
    await settle();
    expect(document.activeElement).toBe(filter);
    filter.blur();
    ports.query = { ...ports.query, data: before };
    rerender(<DriverRosterPanel />);
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});
