import { describe, it, expect } from "vitest";
import { scheduledSweepWeek } from "../week-label";

describe("scheduledSweepWeek", () => {
  it("Mon 2026-10-05 08:00 CDT → 2026-09-28", () => {
    expect(scheduledSweepWeek(new Date("2026-10-05T13:00:00Z"))).toEqual({ weekStart: "2026-09-28", weekEnd: "2026-10-04" });
  });
  it("Mon 2026-09-28 08:00 CDT → 2026-09-21", () => {
    expect(scheduledSweepWeek(new Date("2026-09-28T13:00:00Z")).weekStart).toBe("2026-09-21");
  });
  it("DST-change Monday 2026-11-02 08:00 CST → 2026-10-26", () => {
    expect(scheduledSweepWeek(new Date("2026-11-02T14:00:00Z")).weekStart).toBe("2026-10-26");
  });
  it("uses the Central date, not UTC (Sun 23:30 CT = Mon UTC)", () => {
    expect(scheduledSweepWeek(new Date("2026-10-05T04:30:00Z")).weekStart).toBe("2026-09-21");
  });
});
