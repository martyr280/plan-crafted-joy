// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useDriverTime", () => ({
  useUpdateDriverTimeEvent: () => ({ mutate: () => {}, isPending: false }),
}));

import { DriverTimeReport } from "@/components/driver-time/DriverTimeReport";
import { estimatedCostFigure } from "@/lib/driver-time/cost-coverage";
import { applyMissingPaycom, priceDriverWeek, type RatedCostInput } from "@/lib/driver-time/rates";

const bounds = {
  samsaraWeekHours: 0,
  unsplitMinutes: 0,
  weekStart: "2026-11-09",
  weekEnd: "2026-11-13",
};

function input(
  driverId: string,
  minutes: number,
  paycom: number | null,
  withRate: boolean,
): RatedCostInput {
  return {
    ...bounds,
    driverId,
    paycomHours: paycom,
    flaggedHours: minutes / 60,
    byDay: minutes > 0 ? { "2026-11-10": minutes } : {},
    rates: withRate
      ? [{ id: driverId, driver_id: driverId, hourly_rate: 20, effective_date: "2026-11-01" }]
      : [],
  };
}

function row(name: string, minutes: number, cost: ReturnType<typeof applyMissingPaycom>) {
  return {
    driverId: name,
    driverName: name,
    hub: "Dallas",
    flaggedMinutes: minutes,
    automatedMinutes: minutes,
    officialMinutes: 0,
    varianceMinutes: minutes,
    official: null,
    cost,
    history: [],
    events: [],
  };
}

afterEach(() => cleanup());

describe("missing Paycom keeps known warehouse minutes uncosted", () => {
  const priced = applyMissingPaycom(
    priceDriverWeek(true, input("Alex Rivera", 120, 39, true)),
    39,
    true,
  );
  const missing = applyMissingPaycom(
    priceDriverWeek(true, input("Jordan Ellis", 120, null, true)),
    null,
    true,
  );

  it("moves authorized minutes to not costed and does not infer overtime", () => {
    expect(priced).toMatchObject({
      cost: 40,
      pricedMinutes: 120,
      excludedMinutes: 0,
      multiplier: 1,
    });
    expect(missing.cost).toBeNull();
    expect(missing.multiplier).toBeNull();
    expect(missing.pricedMinutes).toBe(0);
    expect(missing.excludedMinutes).toBe(120);
    expect(missing.note).toBe("Enter Paycom paid hours to estimate cost");
    const drivers = [{ cost: priced }, { cost: missing }];
    expect(estimatedCostFigure(true, drivers).text).toBe(
      "At least $40 (2h priced, 2h not costed; 1 unpriced)",
    );
  });

  it("keeps a genuine zero, and a denied caller gets no pricing metadata", () => {
    const zero = applyMissingPaycom(priceDriverWeek(true, input("Zero", 0, 39, true)), 39, true);
    expect(zero.cost).toBe(0);
    expect(zero.pricedMinutes).toBe(0);
    expect(zero.excludedMinutes).toBe(0);
    expect(estimatedCostFigure(true, [{ cost: zero }])).toEqual({ partial: false, text: "$0" });

    const raw = priceDriverWeek(true, input("Jordan Ellis", 120, null, true));
    const denied = applyMissingPaycom(raw, null, false);
    expect(denied.cost).toBeNull();
    expect(denied.multiplier).toBeNull();
    expect(denied.hourlyRate).toBeNull();
    expect(denied.pricedMinutes).toBe(0);
    expect(denied.excludedMinutes).toBe(0);
    expect(denied.dailyRates).toEqual([]);
    expect(JSON.stringify(denied)).not.toMatch(/"cost":40|"hourlyRate":20|"hourly_rate":20/);
    expect(estimatedCostFigure(false, [{ cost: priced }, { cost: denied }]).text).toBe("—");
  });

  it("mounts the report and both cards, and hides the mix while loading", () => {
    const alex = row("Alex Rivera", 120, priced);
    const jordan = row("Jordan Ellis", 120, missing);
    const { unmount } = render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay
        totals={{ drivers: 2, flaggedMinutes: 240, needsReview: 0, officialDrivers: 0 }}
        drivers={[{ cost: priced }, { cost: missing }]}
        hubGroups={[{ hub: "Dallas", drivers: [alex, jordan], flaggedMinutes: 240 }]}
      />,
    );
    expect(screen.getByText("At least $40 (2h priced, 2h not costed; 1 unpriced)")).toBeTruthy();
    const alexCard = screen.getByText("Alex Rivera").closest(".p-4");
    const jordanCard = screen.getByText("Jordan Ellis").closest(".p-4");
    expect(alexCard?.textContent).toMatch(/\$40/);
    expect(alexCard?.textContent).toMatch(/2h priced/);
    expect(jordanCard?.textContent).toMatch(/Enter Paycom paid hours/);
    expect(jordanCard?.textContent).toMatch(/2h not costed/);
    expect(jordanCard?.textContent).not.toMatch(/\$40|1\.5×/);
    unmount();

    render(
      <DriverTimeReport
        isError={false}
        isLoading
        hasData={false}
        onRetry={vi.fn()}
        canManageDriverPay
        drivers={[{ cost: priced }, { cost: missing }]}
      />,
    );
    expect(screen.getAllByLabelText("Loading")).toHaveLength(4);
    expect(screen.queryByText(/At least \$40/)).toBeNull();
    expect(screen.queryByText(/2h not costed/)).toBeNull();
  });
});
