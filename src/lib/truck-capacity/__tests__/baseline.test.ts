import { describe, it, expect } from "vitest";
import { baselineFromSnapshot, baselinePoint } from "../baseline";

const R = (date: string, cap: number) => ({ date, cap });

describe("baseline", () => {
  it("returns null forecast when no active weekdays and no typicalDow", () => {
    const days = baselineFromSnapshot([], [], "2026-07-01", 3, []);
    expect(days).toHaveLength(3);
    for (const d of days) expect(d.baseline).toBeNull();
  });

  it("uses trimmed mean per weekday and applies month factor", () => {
    // 8 Thursdays with capacity 0.5, all within trailing 56d.
    const runs = [];
    for (let i = 1; i <= 8; i++) {
      const dt = new Date("2026-06-25T00:00:00Z"); // Thu
      dt.setUTCDate(dt.getUTCDate() - 7 * i);
      runs.push(R(dt.toISOString().slice(0, 10), 0.5));
    }
    const days = baselineFromSnapshot(runs, [], "2026-07-01", 14, []);
    // Should predict Thursdays with baseline ~0.5.
    const thursdays = days.filter((d) => d.dow === 4);
    expect(thursdays.length).toBeGreaterThan(0);
    for (const d of thursdays) {
      expect(d.baseline).not.toBeNull();
      expect(d.forecast).not.toBeNull();
      // Since overall mean == monthly mean, factor should shrink toward 1.
      expect(d.seasonal).toBeCloseTo(1, 1);
    }
  });

  it("baselinePoint falls back to route mean when no matching weekday history", () => {
    const runs = [R("2026-06-01", 0.4), R("2026-06-05", 0.4), R("2026-06-10", 0.4)];
    // Predict a weekday that never appeared; expect fallback to route mean 0.4.
    const p = baselinePoint(runs, [], "2026-07-15");
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.6);
  });

  it("hub-mean fallback when route has zero runs", () => {
    const p = baselinePoint([], [0.6, 0.7, 0.8], "2026-07-15");
    expect(p).toBeCloseTo(0.7, 2);
  });
});
