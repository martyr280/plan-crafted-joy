import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", async () => ({
  createServerFn: (await import("./fixtures/weekly-db")).serverFnChain,
}));
vi.mock("@/lib/branch-guard", () => ({ denyLegacyBranchAccess: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => ({
  supabaseAdmin: (await import("./fixtures/weekly-db")).supabaseAdminMock,
}));

import { getDriverTimeWeek } from "@/lib/driver-time.functions";
import { driverName, resetWeeklyDb, weekTables, weeklyDb, WEEK } from "./fixtures/weekly-db";

type DriverRow = {
  driverId: string;
  flaggedMinutes: number;
  official: unknown;
  cost: { cost: number | null };
};
type Week = {
  drivers: DriverRow[];
  totals: {
    drivers: number;
    estimatedCost: number | null;
    hiddenByRoster: { drivers: number; events: number; officialTotals: number };
  };
};
const runWeek = getDriverTimeWeek as unknown as (input: {
  data: unknown;
  context: { userId: string };
}) => Promise<Week>;

type Exclusions = {
  excludedDriverIds?: string[];
  excludedDrivers?: Array<{ id: string; hiddenFrom: string }>;
  patterns?: string[];
};

/** F gets an official warehouse actual of 120 Tuesday minutes ($40 at $20/h, Paycom 39h). */
function tablesWith(x: Exclusions, opts: { officialF?: boolean; fEvents?: boolean } = {}) {
  const t = weekTables(["F", "P", "U"]);
  if (opts.fEvents === false) {
    t.driver_warehouse_events = t.driver_warehouse_events.filter((e) => e.driver_id !== "drv-F");
  }
  if (opts.officialF) {
    const row = t.driver_time_week_overrides.find((o) => o.driver_id === "drv-F")!;
    row.warehouse_actual = {
      driverName: driverName("F"),
      hub: "Dallas",
      minutes: 120,
      scope: "weekdays",
      source: "Synthetic official report",
      reason: "Synthetic test fixture",
      intervals: [
        {
          date: WEEK.tuesday,
          start: `${WEEK.tuesday}T08:00:00-06:00`,
          end: `${WEEK.tuesday}T10:00:00-06:00`,
          minutes: 120,
        },
      ],
    };
  }
  return {
    ...t,
    app_settings: [
      {
        key: "driver_time",
        value: {
          excludedDriverIds: x.excludedDriverIds ?? [],
          excludedDrivers: x.excludedDrivers ?? [],
          excludedDriverNamePatterns: x.patterns ?? [],
        },
        updated_at: "2026-11-01T00:00:00+00:00",
      },
    ],
  };
}

async function week(roles: string[], tables: ReturnType<typeof tablesWith>) {
  resetWeeklyDb(roles, tables);
  return runWeek({ data: { weekStart: WEEK.start }, context: { userId: "u" } });
}

/** Rows without the fixture's sequential event ids, which differ per build. */
const rows = (w: Week, only?: string) =>
  w.drivers
    .filter((d) => !only || d.driverId === only)
    .map((d) => JSON.parse(JSON.stringify(d).replace(/"ev-[A-Z0-9]+-\d+"/g, '"ev"')));
const ids = (w: Week) => w.drivers.map((d) => d.driverId).sort();
const costOf = (w: Week, id: string) => w.drivers.find((d) => d.driverId === id)?.cost.cost;

describe("weekly report with hidden drivers", () => {
  it("drops a legacy-hidden driver from rows and cost but reports the drop, writing nothing", async () => {
    const tables = tablesWith({ excludedDriverIds: ["drv-P"] });
    const ratesBefore = structuredClone(tables.driver_pay_rates);
    const res = await week(["ops_logistics_admin"], tables);
    expect(ids(res)).toEqual(["drv-F", "drv-U"]);
    expect(res.totals.hiddenByRoster).toEqual({ drivers: 1, events: 2, officialTotals: 0 });
    expect(weeklyDb.writes).toBe(0);
    expect(weeklyDb.tables.driver_pay_rates).toEqual(ratesBefore);
  });

  it("pattern-only exclusions (shared logins) are not counted as hidden drivers", async () => {
    const res = await week(["ops_logistics"], tablesWith({ patterns: [driverName("U")] }));
    expect(ids(res)).toEqual(["drv-F", "drv-P"]);
    expect(res.totals.hiddenByRoster).toEqual({ drivers: 0, events: 0, officialTotals: 0 });
  });

  it("restoring (removing the id) brings the driver and their priced cost back", async () => {
    const hidden = await week(
      ["ops_logistics_admin"],
      tablesWith({ excludedDriverIds: ["drv-F"] }),
    );
    const restored = await week(["ops_logistics_admin"], tablesWith({}));
    expect(restored.totals.drivers).toBe(hidden.totals.drivers + 1);
    expect(restored.totals.estimatedCost!).toBeGreaterThan(hidden.totals.estimatedCost!);
  });
});

describe("official warehouse actuals follow the same exclusion", () => {
  for (const fEvents of [true, false]) {
    const label = fEvents ? "with stored events" : "official total only, no events";
    it(`hidden driver's official total and $40 leave the report (${label})`, async () => {
      const visible = await week(
        ["ops_logistics_admin"],
        tablesWith({}, { officialF: true, fEvents }),
      );
      expect(costOf(visible, "drv-F")).toBe(40);
      expect(visible.drivers.find((d) => d.driverId === "drv-F")?.official).not.toBeNull();

      const hidden = await week(
        ["ops_logistics_admin"],
        tablesWith({ excludedDriverIds: ["drv-F"] }, { officialF: true, fEvents }),
      );
      expect(ids(hidden)).toEqual(["drv-P", "drv-U"]);
      expect(hidden.totals.estimatedCost).toBe(visible.totals.estimatedCost! - 40);
      expect(hidden.totals.hiddenByRoster).toEqual({
        drivers: 1,
        events: fEvents ? 1 : 0,
        officialTotals: 1,
      });
      expect(weeklyDb.writes).toBe(0);
      // Stored official actual is untouched.
      const row = weeklyDb.tables.driver_time_week_overrides.find((o) => o.driver_id === "drv-F");
      expect(row?.warehouse_actual).toMatchObject({ minutes: 120 });

      const restored = await week(
        ["ops_logistics_admin"],
        tablesWith({}, { officialF: true, fEvents }),
      );
      expect(costOf(restored, "drv-F")).toBe(40);
      expect(restored.totals.estimatedCost).toBe(visible.totals.estimatedCost);
    });
  }
});

describe("dated hides apply from hiddenFrom on, never to earlier weeks", () => {
  const dated = (hiddenFrom: string) => ({ excludedDrivers: [{ id: "drv-F", hiddenFrom }] });

  it("a week before hiddenFrom keeps the hidden driver's time, official total and cost", async () => {
    const none = await week(["ops_logistics_admin"], tablesWith({}, { officialF: true }));
    const past = await week(
      ["ops_logistics_admin"],
      tablesWith(dated("2026-11-16"), { officialF: true }),
    );
    expect(ids(past)).toEqual(["drv-F", "drv-P", "drv-U"]);
    expect(costOf(past, "drv-F")).toBe(40);
    expect(past.totals.estimatedCost).toBe(none.totals.estimatedCost);
    expect(past.totals.hiddenByRoster).toEqual({ drivers: 0, events: 0, officialTotals: 0 });
    expect(rows(past)).toEqual(rows(none));
  });

  it("the week starting on hiddenFrom drops them, with a truthful notice", async () => {
    const on = await week(
      ["ops_logistics_admin"],
      tablesWith(dated("2026-11-09"), { officialF: true }),
    );
    expect(ids(on)).toEqual(["drv-P", "drv-U"]);
    expect(on.totals.hiddenByRoster).toEqual({ drivers: 1, events: 1, officialTotals: 1 });
  });

  it("a mid-week hiddenFrom rounds down to that week's Monday", async () => {
    const mid = await week(
      ["ops_logistics_admin"],
      tablesWith(dated("2026-11-12"), { officialF: true }),
    );
    expect(ids(mid)).toEqual(["drv-P", "drv-U"]);
  });

  it("pay-cost math for drivers who are not hidden does not change", async () => {
    const none = await week(["ops_logistics_admin"], tablesWith({}, { officialF: true }));
    const hidden = await week(
      ["ops_logistics_admin"],
      tablesWith(dated("2026-11-09"), { officialF: true }),
    );
    for (const id of ["drv-P", "drv-U"]) {
      expect(rows(hidden, id)).toEqual(rows(none, id));
      expect(rows(hidden, id)).toHaveLength(1);
    }
  });

  it("legacy and dated together: legacy hides every week, dated only from its week", async () => {
    const both = await week(
      ["ops_logistics_admin"],
      tablesWith({
        excludedDriverIds: ["drv-U"],
        excludedDrivers: [{ id: "drv-F", hiddenFrom: "2026-11-16" }],
      }),
    );
    expect(ids(both)).toEqual(["drv-F", "drv-P"]);
    expect(both.totals.hiddenByRoster).toEqual({ drivers: 1, events: 1, officialTotals: 0 });
  });
});
