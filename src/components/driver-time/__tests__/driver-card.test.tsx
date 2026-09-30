import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/useDriverTime", () => ({ useUpdateDriverTimeEvent: () => ({ mutate: () => {} }) }));

import { DriverCard, thresholdLabel } from "../DriverCard";

// Alberto Fiscal, week 2026-09-21: the live screen shows 16h 31m flagged (991 min).
const driver = {
  driverId: "d1", driverName: "Alberto Fiscal", hub: "Nashville",
  flaggedMinutes: 991, automatedMinutes: 991, officialMinutes: 991, varianceMinutes: 0,
  cost: { cost: null, note: "Enter Paycom paid hours to calculate an estimate" },
  official: { source: "Joe Green sheet", reason: "official", intervals: [] },
  history: [],
  events: [{ id: "e1", event_date: "2026-09-21", start_ts: "2026-09-21T12:00:00Z", end_ts: "2026-09-21T14:00:00Z",
    duration_min: 120, address_name: "NDI Nashville", location_source: "log", statuses: ["onDuty", "yardMove"], status: "new" }],
};

const render = (isAdmin: boolean, t = 90) =>
  renderToStaticMarkup(<DriverCard driver={driver} weekStart="2026-09-21" isAdmin={isAdmin} thresholdMinutes={t} />);

describe("DriverCard (Joe Green 2026-09-30 clean-up)", () => {
  it("non-admin: no Paycom input, no official box, no duty status; shows week total over threshold", () => {
    const html = render(false);
    expect(html).not.toContain("Paycom hrs");
    expect(html).not.toContain("bg-muted/30");
    expect(html).not.toMatch(/onDuty|yardMove/);
    expect(html).toContain("Warehouse time over 1.5 h: 16:31");
  });
  it("admin still sees the official box and cost note", () => {
    const html = render(true);
    expect(html).toContain("bg-muted/30");
    expect(html).toContain("Enter Paycom paid hours");
    expect(html).not.toContain("Paycom hrs");
  });
  it("threshold label follows settings", () => {
    expect(thresholdLabel(90)).toBe("1.5 h");
    expect(thresholdLabel(120)).toBe("2 h");
    expect(render(false, 75)).toContain("Warehouse time over 1.25 h:");
  });
});
