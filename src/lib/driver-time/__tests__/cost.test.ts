import { describe, expect, it } from "vitest";
import { estimateCost } from "../cost";

describe("estimateCost", () => {
  it("uses straight time under 40 hours", () => {
    const e = estimateCost({ driverId: "d1", samsaraWeekHours: 32, flaggedHours: 4, hourlyRate: 25 });
    expect(e.overtime).toBe(false);
    expect(e.multiplier).toBe(1);
    expect(e.cost).toBe(100);
    expect(e.hoursSource).toBe("samsara");
  });

  it("applies 1.5x at or above 40 hours", () => {
    const e = estimateCost({ driverId: "d1", samsaraWeekHours: 40, flaggedHours: 2, hourlyRate: 20 });
    expect(e.overtime).toBe(true);
    expect(e.cost).toBe(60);
  });

  it("prefers pasted Paycom hours over Samsara", () => {
    const e = estimateCost({ driverId: "d1", samsaraWeekHours: 45, paycomHours: 38, flaggedHours: 2, hourlyRate: 20 });
    expect(e.hoursSource).toBe("paycom");
    expect(e.overtime).toBe(false);
    expect(e.cost).toBe(40);
    expect(e.note).toBeNull();
  });

  it("reports 'no rate on file' instead of $0", () => {
    const e = estimateCost({ driverId: "d1", samsaraWeekHours: 42, flaggedHours: 5, hourlyRate: null });
    expect(e.cost).toBeNull();
    expect(e.hourlyRate).toBeNull();
    expect(e.note).toBe("no rate on file");
  });

  it("treats a zero or negative rate as missing", () => {
    expect(estimateCost({ driverId: "d1", samsaraWeekHours: 10, flaggedHours: 1, hourlyRate: 0 }).cost).toBeNull();
  });

  it("clamps negative flagged hours", () => {
    const e = estimateCost({ driverId: "d1", samsaraWeekHours: 10, flaggedHours: -3, hourlyRate: 20 });
    expect(e.flaggedHours).toBe(0);
    expect(e.cost).toBe(0);
  });
});
