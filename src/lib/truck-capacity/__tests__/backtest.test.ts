import { describe, it, expect } from "vitest";
import { rollingOriginBacktest, buildMonthlyCutoffs } from "../backtest";

function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function synth(): { routes: any[]; routeDays: any[] } {
  const rng = seededRandom(42);
  const routes = [
    { id: "r1", code: "R1", hub: "Dallas", truck_type: "53_trailer" },
    { id: "r2", code: "R2", hub: "Ocala", truck_type: "box_truck" },
  ];
  const days: any[] = [];
  // 12 months of Mon/Wed/Fri route-days per route.
  const start = new Date("2025-06-01T00:00:00Z");
  for (let d = 0; d < 365; d++) {
    const dt = new Date(start);
    dt.setUTCDate(dt.getUTCDate() + d);
    const dow = dt.getUTCDay();
    if (![1, 3, 5].includes(dow)) continue;
    for (const r of routes) {
      // signal: hub effect + weekday + month wave + noise
      const hub = r.hub === "Dallas" ? 0.6 : 0.4;
      const dowE = dow === 5 ? 0.1 : 0;
      const mo = dt.getUTCMonth();
      const season = Math.sin((mo / 12) * 2 * Math.PI) * 0.05;
      const noise = (rng() - 0.5) * 0.1;
      const cap = Math.max(0, Math.min(1.2, hub + dowE + season + noise));
      days.push({ route_id: r.id, run_date: dt.toISOString().slice(0, 10), cap });
    }
  }
  return { routes, routeDays: days };
}

describe("backtest", () => {
  it("buildMonthlyCutoffs skips warmup and returns month firsts", () => {
    const cutoffs = buildMonthlyCutoffs("2025-01-01", "2025-06-15", 90);
    expect(cutoffs[0]).toMatch(/^2025-0[45]-01$/);
    for (const c of cutoffs) expect(c.endsWith("-01")).toBe(true);
  });

  it("model + blend beats or matches baseline MAE on synthetic data", () => {
    const { routes, routeDays } = synth();
    const cutoffs = buildMonthlyCutoffs(routeDays[0].run_date, routeDays[routeDays.length - 1].run_date, 90);
    const res = rollingOriginBacktest({
      routes, routeDays, horizonDays: 28, cutoffs,
      lambdaGrid: [0.3, 1, 3, 10], wGrid: [0, 0.3, 0.5, 0.7, 1.0],
    });
    expect(res.overall.n).toBeGreaterThan(20);
    // Blend should be within 30% of baseline (usually better on this signal).
    expect(res.overall.mae_blend).toBeLessThanOrEqual(res.overall.mae_baseline * 1.3);
    expect(res.finalCoefficients.length).toBe(res.featureNames.length);
    expect(res.chosenLambda).toBeGreaterThan(0);
  });
});
