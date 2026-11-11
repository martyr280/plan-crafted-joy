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

type Week = {
  drivers: Array<{ driverId: string }>;
  totals: {
    drivers: number;
    estimatedCost: number | null;
    hiddenByRoster: { drivers: number; events: number };
  };
};
const runWeek = getDriverTimeWeek as unknown as (input: {
  data: unknown;
  context: { userId: string };
}) => Promise<Week>;

function tablesWith(excludedDriverIds: string[], patterns: string[] = []) {
  const t = weekTables(["F", "P", "U"]);
  return {
    ...t,
    app_settings: [
      {
        key: "driver_time",
        value: { excludedDriverIds, excludedDriverNamePatterns: patterns },
        updated_at: "2026-11-01T00:00:00+00:00",
      },
    ],
  };
}

describe("weekly report with hidden drivers", () => {
  it("drops a hidden driver from rows and cost but reports the drop, writing nothing", async () => {
    resetWeeklyDb(["ops_logistics_admin"], tablesWith(["drv-P"]));
    const ratesBefore = structuredClone(weeklyDb.tables.driver_pay_rates);
    const res = await runWeek({ data: { weekStart: WEEK.start }, context: { userId: "u" } });
    expect(res.drivers.map((d) => d.driverId).sort()).toEqual(["drv-F", "drv-U"]);
    expect(res.totals.hiddenByRoster).toEqual({ drivers: 1, events: 2 });
    expect(weeklyDb.writes).toBe(0);
    expect(weeklyDb.tables.driver_pay_rates).toEqual(ratesBefore);
  });

  it("pattern-only exclusions (shared logins) are not counted as hidden drivers", async () => {
    resetWeeklyDb(["ops_logistics"], tablesWith([], [driverName("U")]));
    const res = await runWeek({ data: { weekStart: WEEK.start }, context: { userId: "u" } });
    expect(res.drivers.map((d) => d.driverId).sort()).toEqual(["drv-F", "drv-P"]);
    expect(res.totals.hiddenByRoster).toEqual({ drivers: 0, events: 0 });
  });

  it("restoring (removing the id) brings the driver and their priced cost back", async () => {
    resetWeeklyDb(["ops_logistics_admin"], tablesWith(["drv-F"]));
    const hidden = await runWeek({ data: { weekStart: WEEK.start }, context: { userId: "u" } });
    resetWeeklyDb(["ops_logistics_admin"], tablesWith([]));
    const restored = await runWeek({ data: { weekStart: WEEK.start }, context: { userId: "u" } });
    expect(restored.totals.drivers).toBe(hidden.totals.drivers + 1);
    expect(restored.totals.estimatedCost!).toBeGreaterThan(hidden.totals.estimatedCost!);
  });
});
