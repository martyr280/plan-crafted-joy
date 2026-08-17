import { describe, expect, it } from "vitest";
import { interpolateScheduleTokens } from "../sales-annualized-template";
import { reportPeriod } from "../sales-reports.server";
import { quarterLabelForDate } from "../spiff.server";

// 2026-09-01T01:00:00Z is Aug 31, 8pm Central.
const AUG31_EVENING = new Date("2026-09-01T01:00:00Z");

describe("Central-anchored business calendar", () => {
  it("interpolateScheduleTokens uses the Central month", () => {
    const out = interpolateScheduleTokens("{cy}|{Mon}", AUG31_EVENING);
    expect(out).toBe("2026|Jul");
  });

  it("reportPeriod returns July 2026", () => {
    const p = reportPeriod(AUG31_EVENING);
    expect(p.month).toBe(7);
    expect(p.year).toBe(2026);
    expect(p.currentYear).toBe(2026);
  });

  it("quarterLabelForDate returns the just-ended quarter in Central", () => {
    // Sep 30, 8pm Central -> still Q3, so the just-ended quarter is Q2-2026.
    const q = quarterLabelForDate(new Date("2026-10-01T01:00:00Z"), "America/Chicago");
    expect(q.quarter).toBe("Q2-2026");
    expect(q.from).toBe("2026-04-01");
    expect(q.toExclusive).toBe("2026-07-01");
  });
});
