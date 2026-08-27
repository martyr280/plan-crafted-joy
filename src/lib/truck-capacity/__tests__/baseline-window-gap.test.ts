// 1b: activeDows uses an 84-day window while byDow uses a 56-day window, so a
// weekday can be "active" with zero samples inside the baseline window. The
// baseline then silently degrades to the all-weekday route mean while the
// explain string still claims a weekday baseline.
//
// Reachable with live data as of 2026-08-27: CAL dow=4 (n84=2, n56=0) and
// TAMPA dow=4 (n84=2, n56=0).

import { describe, it, expect } from "vitest";
import { baselineFromSnapshot } from "../baseline";

describe("baseline window mismatch (84d active vs 56d samples)", () => {
  it("marks a weekday baseline that fell back to the route mean", () => {
    // asOf 2026-08-27. Two Thursdays at 0.90 sit between 84 and 56 days back
    // (so they make Thursday active but contribute no 56d samples).
    const runs = [
      { date: "2026-06-11", cap: 0.9 }, // Thu, 77d back
      { date: "2026-06-18", cap: 0.9 }, // Thu, 70d back
      // Recent non-Thursday history inside 56d.
      { date: "2026-08-03", cap: 0.3 }, // Mon
      { date: "2026-08-10", cap: 0.3 }, // Mon
      { date: "2026-08-17", cap: 0.3 }, // Mon
    ];
    const days = baselineFromSnapshot(runs, [], "2026-08-27", 14, []);
    const thu = days.find((d) => d.dow === 4);
    expect(thu).toBeTruthy();
    // Route-mean fallback: 0.30, not a Thursday baseline.
    expect(thu!.baseline).toBeCloseTo(0.3, 3);
    expect(thu!.n_baseline).toBe(0);
    // Must be labelled honestly rather than presented as a weekday baseline.
    expect((thu as any).baseline_source).toBe("route_mean");
    expect((thu as any).low_confidence).toBe(true);
    expect(thu!.explain).toMatch(/route mean/i);
  });

  it("a weekday with real 56d samples stays a weekday baseline", () => {
    const runs = [
      { date: "2026-08-06", cap: 0.7 }, // Thu
      { date: "2026-08-13", cap: 0.7 }, // Thu
    ];
    const days = baselineFromSnapshot(runs, [], "2026-08-27", 14, []);
    const thu = days.find((d) => d.dow === 4)!;
    expect(thu.n_baseline).toBe(2);
    expect((thu as any).baseline_source).toBe("weekday");
    expect((thu as any).low_confidence).toBe(false);
  });
});
