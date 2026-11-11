// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@tanstack/react-start", async () => ({
  createServerFn: (await import("./fixtures/weekly-db")).serverFnChain,
}));
vi.mock("@/lib/branch-guard", () => ({ denyLegacyBranchAccess: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => ({
  supabaseAdmin: (await import("./fixtures/weekly-db")).supabaseAdminMock,
}));
vi.mock("@/lib/driver-time/rates", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/driver-time/rates")>();
  return { ...real, applyMissingPaycom: vi.fn(real.applyMissingPaycom) };
});
vi.mock("@/hooks/useDriverTime", () => ({
  useUpdateDriverTimeEvent: () => ({ mutate: () => {}, isPending: false }),
}));

import { getDriverTimeWeek } from "@/lib/driver-time.functions";
import { applyMissingPaycom } from "@/lib/driver-time/rates";
import {
  costCoverageNotice,
  driverCostCoverage,
  estimatedCostFigure,
} from "@/lib/driver-time/cost-coverage";
import { formatMinutes } from "@/lib/driver-time/reconciliation";
import { DriverTimeReport } from "@/components/driver-time/DriverTimeReport";
import { warningTextClass } from "@/components/driver-time/text-classes";
import {
  driverName,
  resetWeeklyDb,
  weekTables,
  weeklyDb,
  type Category,
} from "./fixtures/weekly-db";

type WeekResponse = {
  weekStart: string;
  weekEnd: string;
  canManageDriverPay: boolean;
  isAdmin: boolean;
  thresholdMinutes: number;
  drivers: Array<{
    driverId: string;
    driverName: string;
    flaggedMinutes: number;
    cost: {
      cost: number | null;
      hourlyRate: number | null;
      multiplier: number | null;
      overtime: boolean;
      pricedMinutes: number;
      excludedMinutes: number;
      dailyRates: unknown[];
      note: string | null;
    };
  }>;
  hubGroups: Array<{
    hub: string;
    flaggedMinutes: number;
    drivers: Array<{ driverId: string; flaggedMinutes: number } & Record<string, unknown>>;
  }>;
  totals: {
    drivers: number;
    flaggedMinutes: number;
    needsReview: number;
    officialDrivers: number;
    estimatedCost: number | null;
    driversWithoutRate: number;
  };
};

const PAY = ["ops_logistics_admin"];
const runWeek = getDriverTimeWeek as unknown as (input: {
  data: unknown;
  context: { userId: string };
}) => Promise<WeekResponse>;

async function loadWeek(mix: Category[], roles = PAY, extra?: Parameters<typeof weekTables>[1]) {
  resetWeeklyDb(roles, weekTables(mix, extra));
  return runWeek({
    data: { weekStart: "2026-11-11", includeWeekends: false },
    context: { userId: "synthetic-user" },
  });
}

function mount(week: WeekResponse) {
  return render(
    <DriverTimeReport
      isError={false}
      isLoading={false}
      hasData
      onRetry={vi.fn()}
      totals={{ ...week.totals, estimatedCost: week.totals.estimatedCost ?? undefined }}
      canManageDriverPay={week.canManageDriverPay}
      drivers={week.drivers}
      hubGroups={week.hubGroups}
      thresholdMinutes={week.thresholdMinutes}
      isAdmin={week.isAdmin}
    />,
  );
}

const kpi = (label: string) => screen.getByText(label).parentElement?.textContent ?? "";
const card = (c: Category) => {
  const el = screen.getByText(driverName(c)).closest(".p-4");
  if (!(el instanceof HTMLElement)) throw new Error(`No card for ${c}`);
  return el;
};

/** Independently specified per-driver results for each fixture category. */
const DRIVER: Record<
  "F" | "P" | "U" | "M",
  {
    minutes: number;
    cost: number | null;
    multiplier: number | null;
    priced: number;
    excluded: number;
    paycom: number | null;
  }
> = {
  F: { minutes: 120, cost: 40, multiplier: 1, priced: 120, excluded: 0, paycom: 39 },
  P: { minutes: 240, cost: 40, multiplier: 1, priced: 120, excluded: 120, paycom: 39 },
  U: { minutes: 120, cost: null, multiplier: null, priced: 0, excluded: 120, paycom: 39 },
  M: { minutes: 120, cost: null, multiplier: null, priced: 0, excluded: 120, paycom: null },
};

const MATRIX: Array<{
  mix: Array<"F" | "P" | "U" | "M">;
  figure: string;
  partial: boolean;
  full: number;
  part: number;
  unpriced: number;
  sum: number;
  priced: number;
  excluded: number;
}> = [
  // Missing-Paycom mixes.
  {
    mix: ["M"],
    figure: "—",
    partial: false,
    full: 0,
    part: 0,
    unpriced: 1,
    sum: 0,
    priced: 0,
    excluded: 120,
  },
  {
    mix: ["F", "M"],
    figure: "At least $40 (2h priced, 2h not costed; 1 unpriced)",
    partial: true,
    full: 1,
    part: 0,
    unpriced: 1,
    sum: 40,
    priced: 120,
    excluded: 120,
  },
  {
    mix: ["P", "M"],
    figure: "At least $40 (2h priced, 4h not costed; 1 unpriced)",
    partial: true,
    full: 0,
    part: 1,
    unpriced: 1,
    sum: 40,
    priced: 120,
    excluded: 240,
  },
  {
    mix: ["U", "M"],
    figure: "—",
    partial: false,
    full: 0,
    part: 0,
    unpriced: 2,
    sum: 0,
    priced: 0,
    excluded: 240,
  },
  {
    mix: ["F", "P", "U", "M"],
    figure: "At least $80 (4h priced, 6h not costed; 2 unpriced)",
    partial: true,
    full: 1,
    part: 1,
    unpriced: 2,
    sum: 80,
    priced: 240,
    excluded: 360,
  },
  // Aggregate mixes already covered at the pricer level, retained end to end.
  {
    mix: ["F", "P"],
    figure: "At least $80 (4h priced, 2h not costed)",
    partial: true,
    full: 1,
    part: 1,
    unpriced: 0,
    sum: 80,
    priced: 240,
    excluded: 120,
  },
  {
    mix: ["F", "U"],
    figure: "At least $40 (2h priced, 2h not costed; 1 unpriced)",
    partial: true,
    full: 1,
    part: 0,
    unpriced: 1,
    sum: 40,
    priced: 120,
    excluded: 120,
  },
  {
    mix: ["P", "U"],
    figure: "At least $40 (2h priced, 4h not costed; 1 unpriced)",
    partial: true,
    full: 0,
    part: 1,
    unpriced: 1,
    sum: 40,
    priced: 120,
    excluded: 240,
  },
  {
    mix: ["F", "P", "U"],
    figure: "At least $80 (4h priced, 4h not costed; 1 unpriced)",
    partial: true,
    full: 1,
    part: 1,
    unpriced: 1,
    sum: 80,
    priced: 240,
    excluded: 240,
  },
];

beforeEach(() => vi.mocked(applyMissingPaycom).mockClear());
afterEach(() => cleanup());

describe("weekly handler → missing-Paycom adapter → coverage → mounted report", () => {
  it.each(MATRIX.map((c) => ({ ...c, name: c.mix.join("+") })))(
    "$name reconciles every authorized minute",
    async (c) => {
      const week = await loadWeek(c.mix);
      expect(weeklyDb.writes).toBe(0);
      expect(week.weekStart).toBe("2026-11-09");
      expect(week.weekEnd).toBe("2026-11-13");
      expect(week.canManageDriverPay).toBe(true);
      expect(weeklyDb.reads).toContain("driver_pay_rates");

      // The real handler sends every driver through applyMissingPaycom.
      expect(applyMissingPaycom).toHaveBeenCalledTimes(c.mix.length);
      for (const cat of c.mix) {
        expect(applyMissingPaycom).toHaveBeenCalledWith(
          expect.objectContaining({ driverId: `drv-${cat}` }),
          DRIVER[cat].paycom,
          true,
        );
      }

      // Adapted weekly response, per driver.
      const warehouse = c.mix.reduce((s, cat) => s + DRIVER[cat].minutes, 0);
      expect(week.totals.flaggedMinutes).toBe(warehouse);
      expect(week.drivers).toHaveLength(c.mix.length);
      for (const cat of c.mix) {
        const d = week.drivers.find((x) => x.driverId === `drv-${cat}`);
        const want = DRIVER[cat];
        expect(d?.flaggedMinutes).toBe(want.minutes);
        expect(d?.cost).toMatchObject({
          cost: want.cost,
          multiplier: want.multiplier,
          pricedMinutes: want.priced,
          excludedMinutes: want.excluded,
        });
        expect(d!.cost.pricedMinutes + d!.cost.excludedMinutes).toBe(d!.flaggedMinutes);
        if (want.cost != null) expect(want.cost).toBe((want.priced / 60) * 20);
      }

      // Coverage.
      const coverage = driverCostCoverage(week.drivers);
      expect(coverage).toEqual({
        included: c.mix.length,
        fullyPriced: c.full,
        partlyPriced: c.part,
        unpriced: c.unpriced,
        pricedMinutes: c.priced,
        excludedMinutes: c.excluded,
        sum: c.sum,
      });
      expect(coverage.pricedMinutes + coverage.excludedMinutes).toBe(warehouse);
      expect(estimatedCostFigure(true, week.drivers)).toEqual({
        partial: c.partial,
        text: c.figure,
      });

      // Mounted Report and real Cards.
      mount(week);
      expect(kpi("Warehouse time (H:MM)")).toContain(formatMinutes(warehouse));
      expect(kpi("Estimated cost")).toContain(c.figure);
      if (c.partial) {
        expect(screen.getByText(c.figure).className).toContain(warningTextClass);
      } else {
        expect(kpi("Estimated cost")).not.toMatch(/\$/);
      }
      const notice = costCoverageNotice(coverage);
      expect(notice).toContain(
        `${c.full} fully priced, ${c.part} partly priced, ${c.unpriced} unpriced.`,
      );
      const noticeEl = screen.getByText(notice!);
      expect(noticeEl.className).toContain(warningTextClass);

      for (const cat of c.mix) {
        const pay = within(card(cat)).getByTestId("driver-pay-cost");
        if (cat === "F") {
          expect(pay.textContent).toMatch(/^\$40 est\. \(1× · paycom hours\)2h priced$/);
          expect(within(card(cat)).queryByTestId("driver-pay-exclusion")).toBeNull();
        } else if (cat === "P") {
          expect(pay.textContent).toMatch(/At least \$40 est\./);
          expect(within(pay).getByTestId("driver-pay-priced").textContent).toBe("2h priced");
          const ex = within(pay).getByTestId("driver-pay-exclusion");
          expect(ex.textContent).toBe("no rate on file for 2026-11-09 (2 h not costed)");
          expect(ex.className).toContain(warningTextClass);
        } else if (cat === "U") {
          expect(pay.textContent).toMatch(/^no rate on file/);
          expect(within(pay).getByTestId("driver-pay-exclusion").textContent).toBe("2h not costed");
          expect(pay.textContent).not.toMatch(/\$|×/);
        } else {
          expect(pay.textContent).toMatch(/^Enter Paycom paid hours to estimate cost/);
          expect(within(pay).getByTestId("driver-pay-exclusion").textContent).toBe("2h not costed");
          expect(within(pay).queryByTestId("driver-pay-priced")).toBeNull();
          expect(pay.textContent).not.toMatch(/\$|×/);
        }
      }
    },
  );

  it("N7: the single partly priced driver stays a lower bound and the card shows the exclusion", async () => {
    const week = await loadWeek(["P"]);
    expect(estimatedCostFigure(true, week.drivers).text).toBe(
      "At least $40 (2h priced, 2h not costed)",
    );
    mount(week);
    expect(screen.getByText("At least $40 (2h priced, 2h not costed)").className).toContain(
      warningTextClass,
    );
    expect(screen.getByText(/0 fully priced, 1 partly priced, 0 unpriced\./)).toBeTruthy();
    expect(within(card("P")).getByTestId("driver-pay-exclusion").textContent).toBe(
      "no rate on file for 2026-11-09 (2 h not costed)",
    );
  });

  it("N9: missing Paycom keeps a known rate but counts as unpriced and infers no overtime", async () => {
    const week = await loadWeek(["F", "M"]);
    const m = week.drivers.find((d) => d.driverId === "drv-M")!;
    // The rate is known; coverage still counts the computed cost, not the rate.
    expect(m.cost.hourlyRate).toBe(20);
    expect(m.cost).toMatchObject({ cost: null, multiplier: null, overtime: false });
    expect(week.totals.driversWithoutRate).toBe(0);
    expect(driverCostCoverage(week.drivers).unpriced).toBe(1);

    const heavy = await loadWeek(["M"], PAY, {
      mMinutesByDay: {
        "2026-11-09": 600,
        "2026-11-10": 600,
        "2026-11-11": 600,
        "2026-11-12": 600,
        "2026-11-13": 600,
      },
    });
    expect(heavy.drivers[0].flaggedMinutes).toBe(3000);
    expect(heavy.drivers[0].cost).toMatchObject({
      cost: null,
      multiplier: null,
      overtime: false,
      pricedMinutes: 0,
      excludedMinutes: 3000,
    });
    mount(heavy);
    const pay = within(card("M")).getByTestId("driver-pay-cost");
    expect(within(pay).getByTestId("driver-pay-exclusion").textContent).toBe("50h not costed");
    expect(pay.textContent).not.toMatch(/\$|1\.5×|1×/);
  });

  it.each([
    { name: "Z0", mix: ["Z0"] as Category[], figure: { partial: false, text: "$0" } },
    {
      name: "Z0+ZM",
      mix: ["Z0", "ZM"] as Category[],
      figure: { partial: true, text: "Partial: $0 (1 fully priced, 1 unpriced)" },
    },
    { name: "ZM", mix: ["ZM"] as Category[], figure: { partial: false, text: "—" } },
    {
      name: "F+M",
      mix: ["F", "M"] as Category[],
      figure: { partial: true, text: "At least $40 (2h priced, 2h not costed; 1 unpriced)" },
    },
  ])(
    "keeps known zero, partial zero, all-null and a partial subtotal distinct: $name",
    async ({ mix, figure }) => {
      const week = await loadWeek(mix);
      expect(estimatedCostFigure(true, week.drivers)).toEqual(figure);
      for (const d of week.drivers) {
        if (d.driverId === "drv-Z0") expect(d.cost.cost).toBe(0);
        if (d.driverId === "drv-ZM") expect(d.cost.cost).toBeNull();
      }
      mount(week);
      expect(kpi("Estimated cost")).toContain(figure.text);
    },
  );

  it("all-known drivers show plain USD with no partial wording", async () => {
    resetWeeklyDb(PAY, {
      ...weekTables(["F"]),
      driver_warehouse_events: [
        ...weekTables(["F"]).driver_warehouse_events,
        ...weekTables(["F"]).driver_warehouse_events.map((e) => ({
          ...e,
          id: `${e.id}-2`,
          driver_id: "drv-F2",
          driver_name: "Fern Fullrate",
        })),
      ],
      driver_pay_rates: [
        ...weekTables(["F"]).driver_pay_rates,
        { ...weekTables(["F"]).driver_pay_rates[0], id: "rate-F2", driver_id: "drv-F2" },
      ],
      driver_time_week_overrides: [
        ...weekTables(["F"]).driver_time_week_overrides,
        { ...weekTables(["F"]).driver_time_week_overrides[0], id: "ovr-F2", driver_id: "drv-F2" },
      ],
    });
    const week = await runWeek({
      data: { weekStart: "2026-11-09" },
      context: { userId: "synthetic-user" },
    });
    expect(estimatedCostFigure(true, week.drivers)).toEqual({ partial: false, text: "$80" });
    mount(week);
    expect(kpi("Estimated cost")).toBe("Estimated cost$80");
    expect(screen.queryByText(/fully priced/)).toBeNull();
  });
});

describe("the real weekly authorization boundary", () => {
  it("a viewer without driver pay gets no amounts, rates or minute metadata", async () => {
    const week = await loadWeek(["F", "P", "U", "M"], ["ops_logistics"]);
    expect(week.canManageDriverPay).toBe(false);
    expect(weeklyDb.reads).not.toContain("driver_pay_rates");
    expect(week.totals.estimatedCost).toBeNull();
    expect(week.totals.flaggedMinutes).toBe(600);
    for (const d of week.drivers) {
      expect(d.cost).toMatchObject({
        cost: null,
        hourlyRate: null,
        multiplier: null,
        pricedMinutes: 0,
        excludedMinutes: 0,
        dailyRates: [],
      });
    }
    expect(applyMissingPaycom).toHaveBeenCalledWith(expect.anything(), null, false);
    expect(JSON.stringify(week)).not.toMatch(/hourly_rate|"hourlyRate":20|"cost":40|not costed/);

    mount(week);
    expect(kpi("Estimated cost")).toBe("Estimated cost—");
    expect(screen.queryByTestId("driver-pay-cost")).toBeNull();
    expect(screen.queryByText(/fully priced|not costed|At least|Paycom/)).toBeNull();
    expect(kpi("Warehouse time (H:MM)")).toContain(formatMinutes(600));
  });

  it("a caller without a viewer role is refused before any table is read", async () => {
    await expect(loadWeek(["F", "M"], ["ops_orders"])).rejects.toThrow(
      "Logistics or admin role required",
    );
    expect(weeklyDb.reads).toEqual([]);
    expect(applyMissingPaycom).not.toHaveBeenCalled();
  });

  it("a global admin is priced like a logistics admin", async () => {
    const week = await loadWeek(["F", "M"], ["admin"]);
    expect(week.canManageDriverPay).toBe(true);
    expect(estimatedCostFigure(true, week.drivers).text).toBe(
      "At least $40 (2h priced, 2h not costed; 1 unpriced)",
    );
  });
});
