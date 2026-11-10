// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useDriverTime", () => ({
  useUpdateDriverTimeEvent: () => ({ mutate: () => {}, isPending: false }),
}));

import { DriverTimeReport } from "@/components/driver-time/DriverTimeReport";
import { driverCostCoverage, estimatedCostFigure } from "@/lib/driver-time/cost-coverage";
import { estimateCostWithRates, priceDriverWeek, type PayRateRow } from "@/lib/driver-time/rates";

const rates: PayRateRow[] = [
  { id: "r-tue", driver_id: "d1", hourly_rate: 20, effective_date: "2026-11-10" },
];

const week = {
  driverId: "d1",
  samsaraWeekHours: 0,
  paycomHours: 39,
  flaggedHours: 4,
  byDay: { "2026-11-09": 120, "2026-11-10": 120 },
  unsplitMinutes: 0,
  weekStart: "2026-11-09",
  weekEnd: "2026-11-13",
  rates,
};

function rowFrom(cost: ReturnType<typeof estimateCostWithRates>) {
  return {
    driverId: "d1",
    driverName: "Casey Nguyen",
    hub: "Dallas",
    flaggedMinutes: 240,
    automatedMinutes: 240,
    officialMinutes: 0,
    varianceMinutes: 240,
    official: null,
    cost,
    history: [],
    events: [],
  };
}

afterEach(() => cleanup());

describe("partial-day rate from the pricer through the report and card", () => {
  it("labels Monday's uncosted hours as a known subtotal, not a complete $40", () => {
    const estimate = estimateCostWithRates(week);
    expect(estimate.cost).toBe(40);
    expect(estimate.pricedMinutes).toBe(120);
    expect(estimate.excludedMinutes).toBe(120);
    expect(estimate.note).toBe("no rate on file for 2026-11-09 (2 h not costed)");

    const coverage = driverCostCoverage([{ cost: estimate }]);
    expect(coverage).toMatchObject({ fullyPriced: 0, partlyPriced: 1, unpriced: 0 });
    const figure = estimatedCostFigure(true, [{ cost: estimate }]);
    expect(figure.partial).toBe(true);
    expect(figure.text).toBe("At least $40 (2h priced, 2h not costed)");

    const driver = rowFrom(estimate);
    render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay
        totals={{ drivers: 1, flaggedMinutes: 240, needsReview: 0, officialDrivers: 0 }}
        drivers={[{ cost: estimate }]}
        hubGroups={[{ hub: "Dallas", drivers: [driver], flaggedMinutes: 240 }]}
      />,
    );
    const total = screen.getByText("At least $40 (2h priced, 2h not costed)");
    expect(total.className).toMatch(/text-warning-text/);
    expect(screen.getByText(/0 fully priced, 1 partly priced, 0 unpriced/)).toBeTruthy();
    expect(screen.getByTestId("driver-pay-cost").textContent).toMatch(/At least \$40/);
    const exclusion = screen.getByTestId("driver-pay-exclusion");
    expect(exclusion.textContent).toBe("no rate on file for 2026-11-09 (2 h not costed)");
    expect(exclusion.className).toMatch(/text-warning-text/);
  });

  it("keeps a genuine zero complete and hides pay when the role is denied or the week is loading", () => {
    const zero = estimateCostWithRates({
      ...week,
      paycomHours: 39,
      flaggedHours: 0,
      byDay: {},
      rates: [{ id: "r0", driver_id: "d1", hourly_rate: 20, effective_date: "2026-11-01" }],
    });
    expect(zero.cost).toBe(0);
    expect(zero.excludedMinutes).toBe(0);
    expect(estimatedCostFigure(true, [{ cost: zero }])).toEqual({ partial: false, text: "$0" });

    const hidden = priceDriverWeek(false, week);
    expect(hidden.cost).toBeNull();
    expect(hidden.pricedMinutes).toBe(0);
    expect(hidden.excludedMinutes).toBe(0);
    expect(estimatedCostFigure(false, [{ cost: estimateCostWithRates(week) }]).text).toBe("—");

    const driver = rowFrom(estimateCostWithRates(week));
    const { unmount } = render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay={false}
        totals={{ drivers: 1, flaggedMinutes: 240, needsReview: 0, officialDrivers: 0 }}
        drivers={[{ cost: driver.cost }]}
        hubGroups={[{ hub: "Dallas", drivers: [driver], flaggedMinutes: 240 }]}
      />,
    );
    expect(screen.getByText("Estimated cost").parentElement?.textContent).toMatch(/—/);
    expect(screen.queryByTestId("driver-pay-exclusion")).toBeNull();
    expect(screen.queryByText(/At least \$40/)).toBeNull();
    unmount();

    render(
      <DriverTimeReport
        isError={false}
        isLoading
        hasData={false}
        onRetry={vi.fn()}
        canManageDriverPay
        drivers={[{ cost: driver.cost }]}
      />,
    );
    expect(screen.getAllByLabelText("Loading")).toHaveLength(4);
    expect(screen.queryByText(/At least \$40/)).toBeNull();
  });
});
