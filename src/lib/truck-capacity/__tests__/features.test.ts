import { describe, it, expect } from "vitest";
import { buildFeatureContext, featureNames, buildFeatureRow, buildLagBlock } from "../features";

describe("features", () => {
  const routes = [
    { id: "r1", code: "AAA", hub: "Dallas", truck_type: "53_trailer" },
    { id: "r2", code: "BBB", hub: "Ocala", truck_type: "box_truck" },
    { id: "r3", code: "CCC", hub: "Birmingham", truck_type: null },
  ];

  it("feature names are deterministic and length matches", () => {
    const ctx = buildFeatureContext(routes, [{ date: "2026-01-01" }]);
    const names = featureNames(ctx);
    // intercept + 6 dow + 11 month + (3 hubs - 1) + truck_box + trend + 7 lags + (3 routes - 1) = 30
    expect(names.length).toBe(30);
    expect(names[0]).toBe("intercept");
    const lags = buildLagBlock([], [], "2026-07-01", "2026-07-10");
    const x = buildFeatureRow(ctx, routes[0], "2026-07-10", lags);
    expect(x.length).toBe(names.length);
  });

  it("dummies encode target date correctly", () => {
    const ctx = buildFeatureContext(routes, [{ date: "2026-01-01" }]);
    const names = featureNames(ctx);
    const lags = buildLagBlock([], [], "2026-07-01", "2026-07-10"); // Fri, month 7
    const x = buildFeatureRow(ctx, routes[0], "2026-07-10", lags);
    const dowIdx = names.indexOf("dow_5"); // Friday=5
    const monIdx = names.indexOf("month_7");
    expect(x[dowIdx]).toBe(1);
    expect(x[monIdx]).toBe(1);
    // missing_history active
    expect(x[names.indexOf("lag_missing")]).toBe(1);
  });

  it("lag block computes recent-form signals", () => {
    const rr = [
      { date: "2026-06-25", cap: 0.6 }, // Thu
      { date: "2026-06-18", cap: 0.5 }, // Thu
      { date: "2026-06-11", cap: 0.4 }, // Thu
    ];
    const lags = buildLagBlock(rr, [], "2026-07-01", "2026-07-02");
    expect(lags.lastRun).toBe(0.6);
    expect(lags.overallMean56).toBeCloseTo(0.5, 2);
    expect(lags.missingHistory).toBe(0);
    expect(lags.runCountNorm).toBeCloseTo(3 / 30, 3);
  });
});
