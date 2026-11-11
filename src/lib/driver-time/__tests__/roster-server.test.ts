import { beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic in-memory service-role client. Reads filter local rows. The only
// writes allowed are update/insert on app_settings; anything else throws, so a
// test fails loudly if rates, events or capacity rows are ever touched.

type Row = Record<string, unknown>;

const mem = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  roles: new Set<string>(),
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  beforeWrite: null as null | (() => void),
  samsara: [] as Row[],
}));

vi.mock("@tanstack/react-start", async () => ({
  createServerFn: (await import("./fixtures/weekly-db")).serverFnChain,
}));
vi.mock("@/lib/branch-guard", () => ({ denyLegacyBranchAccess: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/samsara/hos.server", () => ({
  fetchDrivers: async () => mem.samsara,
  fetchAddresses: async () => [],
}));
vi.mock("@/lib/samsara/cache.server", () => ({ getDriverTimeInputs: async () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => {
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "insert" = "select";
    let payload: Row = {};
    const run = (from = 0, to = Infinity) => {
      if (op === "insert") {
        if ((mem.tables[table] ?? []).some((r) => r.key === payload.key)) {
          return { data: null, error: { code: "23505", message: "duplicate" }, count: null };
        }
        mem.beforeWrite?.();
        mem.writes.push({ table, op, payload });
        (mem.tables[table] ??= []).push({ ...payload });
        return { data: [{ ...payload }], error: null, count: 1 };
      }
      if (op === "update") {
        mem.beforeWrite?.();
        const hits = (mem.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        for (const r of hits) Object.assign(r, payload);
        if (hits.length) mem.writes.push({ table, op, payload });
        return { data: hits.map((r) => ({ ...r })), error: null, count: hits.length };
      }
      const all = (mem.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: all.slice(from, to + 1), error: null, count: all.length };
    };
    const deny = () => {
      throw new Error(`No writes allowed: ${table}`);
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => {
        filters.push((r) => r[k] === v);
        return q;
      },
      gte: (k: string, v: string) => {
        filters.push((r) => String(r[k]) >= v);
        return q;
      },
      lte: (k: string, v: string) => {
        filters.push((r) => String(r[k]) <= v);
        return q;
      },
      order: () => q,
      limit: () => q,
      range: async (from: number, to: number) => run(from, to),
      maybeSingle: async () => {
        const r = run();
        return { ...r, data: r.data?.[0] ?? null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => run())
          .then(resolve, reject),
      update: (p: Row) => {
        if (table !== "app_settings") deny();
        op = "update";
        payload = p;
        return q;
      },
      insert: (p: Row) => {
        if (table !== "app_settings") deny();
        op = "insert";
        payload = p;
        return q;
      },
      upsert: deny,
      delete: deny,
    };
    return q;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => query(table),
      rpc: async (fn: string, args: { _role?: string }) => {
        if (fn !== "has_role") throw new Error(`Unexpected RPC ${fn}`);
        const role = String(args._role);
        // Mirrors public.has_role: a branch manager holds no other role.
        if (mem.roles.has("branch_manager") && role !== "branch_manager") {
          return { data: false, error: null };
        }
        return { data: mem.roles.has(role), error: null };
      },
    },
  };
});

import {
  getDriverRoster,
  listDriverPayRates,
  setDriverRosterVisibility,
} from "@/lib/driver-time.functions";
import { ROSTER_CONFLICT_MESSAGE } from "@/lib/driver-time/roster";

type Call<R> = (input: { data?: unknown; context: { userId: string } }) => Promise<R>;
type RosterResult = {
  active: Array<{ id: string; name: string }>;
  hidden: Array<{ id: string; name: string; hasRates: boolean }>;
  settingsUpdatedAt: string | null;
  rosterError: string | null;
};
type RatesResult = {
  drivers: Array<{ id: string; name: string }>;
  rates: Row[];
  excludedDrivers?: Array<{ id: string; name: string }>;
};
type SetResult = {
  ok: true;
  changed: boolean;
  updatedAt: string | null;
  excludedDriverIds: string[];
};

const roster = getDriverRoster as unknown as Call<RosterResult>;
const listRates = listDriverPayRates as unknown as Call<RatesResult>;
const setVisibility = setDriverRosterVisibility as unknown as Call<SetResult>;
const ctx = { userId: "user-1" };

const T0 = "2026-09-30T15:54:18.123456+00:00";
const SAVED = {
  excludedDriverIds: ["900"],
  excludedDriverNamePatterns: ["Test Hub LTL"],
  warehouseRemarkDriverIds: ["700"],
  thresholdMinutes: 75,
};

function seed(opts: { settings?: Row | null; roles?: string[] } = {}) {
  mem.roles = new Set(opts.roles ?? ["ops_logistics_admin"]);
  mem.writes = [];
  mem.beforeWrite = null;
  mem.samsara = [
    { id: "100", name: "Avery Active", licenseNumber: "L1", driverActivationStatus: "active" },
    { id: "101", name: "Blake Rated", licenseNumber: "L2", driverActivationStatus: "active" },
  ];
  const settingsRow =
    opts.settings === null
      ? []
      : [{ key: "driver_time", value: structuredClone(opts.settings ?? SAVED), updated_at: T0 }];
  mem.tables = {
    app_settings: settingsRow,
    driver_pay_rates: [
      {
        id: "r1",
        driver_id: "101",
        driver_name: "Blake Rated",
        hourly_rate: 20,
        effective_date: "2026-01-01",
        updated_at: "x",
      },
      {
        id: "r2",
        driver_id: "900",
        driver_name: "Harper Hidden",
        hourly_rate: 22,
        effective_date: "2026-01-01",
        updated_at: "x",
      },
    ],
    driver_warehouse_events: [{ id: "e1", driver_id: "900", driver_name: "Harper Hidden" }],
  };
}

const settingsValue = () => mem.tables.app_settings[0]?.value as Row;

beforeEach(() => seed());

describe("roster gate (UI helper and server use the same driver-pay rule)", () => {
  const ALLOWED = [["admin"], ["ops_logistics_admin"], ["ops_logistics_admin", "ops_logistics"]];
  const DENIED = [
    ["ops_logistics"],
    ["branch_manager"],
    ["branch_manager", "ops_logistics_admin"],
    ["branch_manager", "admin"],
    ["ops_orders"],
    [],
  ];
  for (const roles of ALLOWED) {
    it(`${roles.join("+")} can read the roster and hide/restore`, async () => {
      seed({ roles });
      await expect(roster({ context: ctx })).resolves.toMatchObject({ settingsUpdatedAt: T0 });
      const r = await setVisibility({
        data: { driverId: "100", hidden: true, expectedUpdatedAt: T0 },
        context: ctx,
      });
      expect(r.changed).toBe(true);
    });
  }
  for (const roles of DENIED) {
    it(`${roles.join("+") || "no roles"} is denied on read and write, nothing written`, async () => {
      seed({ roles });
      await expect(roster({ context: ctx })).rejects.toThrow(/Driver pay access required/);
      await expect(
        setVisibility({
          data: { driverId: "100", hidden: true, expectedUpdatedAt: T0 },
          context: ctx,
        }),
      ).rejects.toThrow(/Driver pay access required/);
      await expect(
        setVisibility({
          data: { driverId: "900", hidden: false, expectedUpdatedAt: T0 },
          context: ctx,
        }),
      ).rejects.toThrow(/Driver pay access required/);
      await expect(listRates({ context: ctx })).rejects.toThrow(/Driver pay access required/);
      expect(mem.writes).toEqual([]);
      expect(settingsValue()).toEqual(SAVED);
    });
  }
});

describe("hide / restore writes", () => {
  it("hide appends the id, keeps every other key, and moves the driver to Hidden", async () => {
    const r = await setVisibility({
      data: { driverId: "100", hidden: true, expectedUpdatedAt: T0 },
      context: ctx,
    });
    expect(r).toMatchObject({ ok: true, changed: true, excludedDriverIds: ["900", "100"] });
    expect(r.updatedAt).not.toBe(T0);
    expect(settingsValue()).toEqual({ ...SAVED, excludedDriverIds: ["900", "100"] });
    expect(mem.writes.map((w) => `${w.table}:${w.op}`)).toEqual(["app_settings:update"]);
    const after = await roster({ context: ctx });
    expect(after.active.map((d) => d.id)).toEqual(["101"]);
    expect(after.hidden.map((d) => d.id).sort()).toEqual(["100", "900"]);
    expect(after.settingsUpdatedAt).toBe(r.updatedAt);
  });

  it("hiding twice is a no-op success with no second write, even with a stale token", async () => {
    const first = await setVisibility({
      data: { driverId: "100", hidden: true, expectedUpdatedAt: T0 },
      context: ctx,
    });
    const second = await setVisibility({
      data: { driverId: "100", hidden: true, expectedUpdatedAt: T0 },
      context: ctx,
    });
    expect(second).toMatchObject({ changed: false, updatedAt: first.updatedAt });
    expect(mem.writes).toHaveLength(1);
    expect(settingsValue().excludedDriverIds).toEqual(["900", "100"]);
  });

  it("restore removes only that id and is idempotent", async () => {
    const r = await setVisibility({
      data: { driverId: "900", hidden: false, expectedUpdatedAt: T0 },
      context: ctx,
    });
    expect(r.changed).toBe(true);
    expect(settingsValue()).toEqual({ ...SAVED, excludedDriverIds: [] });
    const again = await setVisibility({
      data: { driverId: "900", hidden: false, expectedUpdatedAt: T0 },
      context: ctx,
    });
    expect(again.changed).toBe(false);
    expect(mem.writes).toHaveLength(1);
  });

  it("a stale token is a conflict and writes nothing", async () => {
    await expect(
      setVisibility({
        data: { driverId: "100", hidden: true, expectedUpdatedAt: "2026-01-01T00:00:00+00:00" },
        context: ctx,
      }),
    ).rejects.toThrow(ROSTER_CONFLICT_MESSAGE);
    expect(mem.writes).toEqual([]);
    expect(settingsValue()).toEqual(SAVED);
  });

  it("a write that lands between read and update is a conflict, and the other write survives", async () => {
    mem.beforeWrite = () => {
      const row = mem.tables.app_settings[0];
      row.value = { ...(row.value as Row), thresholdMinutes: 60 };
      row.updated_at = "2026-11-11T15:00:00.000001+00:00";
      mem.beforeWrite = null;
    };
    await expect(
      setVisibility({
        data: { driverId: "100", hidden: true, expectedUpdatedAt: T0 },
        context: ctx,
      }),
    ).rejects.toThrow(ROSTER_CONFLICT_MESSAGE);
    expect(settingsValue()).toEqual({ ...SAVED, thresholdMinutes: 60 });
  });

  it("with no driver_time row yet, hide inserts only excludedDriverIds", async () => {
    seed({ settings: null });
    const view = await roster({ context: ctx });
    expect(view.settingsUpdatedAt).toBeNull();
    const r = await setVisibility({
      data: { driverId: "100", hidden: true, expectedUpdatedAt: null },
      context: ctx,
    });
    expect(r.changed).toBe(true);
    expect(settingsValue()).toEqual({ excludedDriverIds: ["100"] });
    expect(mem.writes.map((w) => w.op)).toEqual(["insert"]);
  });

  it("rejects ids with unexpected characters before any read", async () => {
    await expect(async () =>
      setVisibility({
        data: { driverId: "1 OR 1=1", hidden: true, expectedUpdatedAt: T0 },
        context: ctx,
      }),
    ).rejects.toThrow(/unexpected characters/);
    expect(mem.writes).toEqual([]);
  });
});

describe("listDriverPayRates honors exclusions", () => {
  it("an excluded driver with a rate row stays off the active list; rate rows stay intact", async () => {
    const r = await listRates({ context: ctx });
    expect(r.drivers.map((d) => d.id)).toEqual(["100", "101"]);
    expect(r.rates.map((x) => x.id).sort()).toEqual(["r1", "r2"]);
    expect(r.excludedDrivers).toBeUndefined();
  });

  it("includeExcluded is the explicit opt-in that brings back their rate history", async () => {
    const r = await listRates({ data: { includeExcluded: true }, context: ctx });
    expect(r.drivers.map((d) => d.id)).toEqual(["100", "101"]);
    expect(r.excludedDrivers).toEqual([
      { id: "900", name: "Harper Hidden", reason: "id", alsoMatchesPattern: false, hasRates: true },
    ]);
  });

  it("restoring the driver puts them back on the active list with their rate", async () => {
    await setVisibility({
      data: { driverId: "900", hidden: false, expectedUpdatedAt: T0 },
      context: ctx,
    });
    const r = await listRates({ context: ctx });
    expect(r.drivers.map((d) => d.id)).toEqual(["100", "101", "900"]);
  });
});
