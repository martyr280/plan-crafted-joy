import { describe, it, expect } from "vitest";
import {
  cutoffDateForRun, pickForecastAtCutoff, weekStartSunday, metricsOf, aggregate,
  byRouteWeek, daysBetween, isSpecialRoute, readinessOf, READINESS_GATE,
  type CutoffLite, type LogRowLite, type ScoredRun,
} from "../accuracy";

// MTN: Tue 16:00 feeds Wed/Thu; Thu 17:00 feeds Mon/Tue.
const MTN: CutoffLite[] = [
  { cutoff_dow: 2, run_dows: [3, 4] },
  { cutoff_dow: 4, run_dows: [1, 2] },
];
// DAL-LOCAL: every weekday cutoff feeds the next weekday (Fri -> Mon).
const DAL_LOCAL: CutoffLite[] = [1, 2, 3, 4, 5].map((d) => ({ cutoff_dow: d, run_dows: [d === 5 ? 1 : d + 1] }));

describe("cutoffDateForRun", () => {
  it("single cutoff: Wed run maps back to the Tue cutoff", () => {
    // 2026-09-09 is a Wednesday.
    expect(cutoffDateForRun("2026-09-09", [{ cutoff_dow: 2, run_dows: [3] }]))
      .toEqual({ cutoffDate: "2026-09-08", cutoffKnown: true });
  });

  it("MTN: a Wednesday run maps to the immediately preceding Tuesday", () => {
    expect(cutoffDateForRun("2026-09-09", MTN)).toEqual({ cutoffDate: "2026-09-08", cutoffKnown: true });
  });

  it("MTN: a Monday run maps to the PREVIOUS Thursday, not the Tuesday", () => {
    // 2026-09-14 Mon -> 2026-09-10 Thu.
    expect(cutoffDateForRun("2026-09-14", MTN)).toEqual({ cutoffDate: "2026-09-10", cutoffKnown: true });
  });

  it("MTN: a Thursday run maps to the Tuesday two days earlier", () => {
    expect(cutoffDateForRun("2026-09-10", MTN)).toEqual({ cutoffDate: "2026-09-08", cutoffKnown: true });
  });

  it("MTN: a Friday run has no qualifying cutoff -> runDate-1, cutoffKnown false", () => {
    expect(cutoffDateForRun("2026-09-11", MTN)).toEqual({ cutoffDate: "2026-09-10", cutoffKnown: false });
  });

  it("DAL-LOCAL: Monday run maps to Friday's cutoff", () => {
    expect(cutoffDateForRun("2026-09-14", DAL_LOCAL)).toEqual({ cutoffDate: "2026-09-11", cutoffKnown: true });
  });

  it("DAL-LOCAL: Wednesday run maps to Tuesday", () => {
    expect(cutoffDateForRun("2026-09-09", DAL_LOCAL)).toEqual({ cutoffDate: "2026-09-08", cutoffKnown: true });
  });

  it("route with no cutoffs at all -> runDate-1 and cutoffKnown false", () => {
    expect(cutoffDateForRun("2026-09-09", [])).toEqual({ cutoffDate: "2026-09-08", cutoffKnown: false });
  });

  it("duplicate identical cutoffs (ARK shape) pick the same single date", () => {
    const ark: CutoffLite[] = [{ cutoff_dow: 3, run_dows: [5] }, { cutoff_dow: 3, run_dows: [5] }];
    expect(cutoffDateForRun("2026-09-11", ark)).toEqual({ cutoffDate: "2026-09-09", cutoffKnown: true });
  });

  it("inactive cutoffs are ignored", () => {
    const c: CutoffLite[] = [{ cutoff_dow: 2, run_dows: [3], active: false }];
    expect(cutoffDateForRun("2026-09-09", c)).toEqual({ cutoffDate: "2026-09-08", cutoffKnown: false });
  });

  it("never returns a date on or after the run date", () => {
    // A cutoff whose own dow equals the run dow must go back a full week.
    expect(cutoffDateForRun("2026-09-09", [{ cutoff_dow: 3, run_dows: [3] }]))
      .toEqual({ cutoffDate: "2026-09-02", cutoffKnown: true });
  });
});

const L = (made_on: string, served: number): LogRowLite =>
  ({ made_on, served, predicted: served, method: "blend", p21_guard_applied: false });

describe("pickForecastAtCutoff", () => {
  it("picks the latest forecast made on or before the cutoff", () => {
    const p = pickForecastAtCutoff([L("2026-09-04", 0.5), L("2026-09-08", 0.62), L("2026-09-09", 0.7)],
      "2026-09-08", "2026-09-09")!;
    expect(p.madeOn).toBe("2026-09-08");
    expect(p.afterCutoff).toBe(false);
    expect(p.leadDays).toBe(1);
  });

  it("falls back to the earliest forecast before the run when all are after the cutoff", () => {
    const p = pickForecastAtCutoff([L("2026-09-10", 0.8), L("2026-09-11", 0.9)], "2026-09-08", "2026-09-12")!;
    expect(p.madeOn).toBe("2026-09-10");
    expect(p.afterCutoff).toBe(true);
    expect(p.leadDays).toBe(2);
  });

  it("returns null when every forecast is on or after the run date", () => {
    expect(pickForecastAtCutoff([L("2026-09-09", 0.8), L("2026-09-12", 0.9)], "2026-09-08", "2026-09-09")).toBeNull();
  });

  it("ignores rows with a null served value", () => {
    const rows: LogRowLite[] = [{ made_on: "2026-09-07", served: null, predicted: 0.4, method: "blend" }];
    expect(pickForecastAtCutoff(rows, "2026-09-08", "2026-09-09")).toBeNull();
  });

  it("returns null on an empty log", () => {
    expect(pickForecastAtCutoff([], "2026-09-08", "2026-09-09")).toBeNull();
  });
});

describe("week helpers", () => {
  it("anchors weeks on Sunday", () => {
    expect(weekStartSunday("2026-09-09")).toBe("2026-09-06"); // Wed -> Sun
    expect(weekStartSunday("2026-09-06")).toBe("2026-09-06"); // Sun -> itself
    expect(weekStartSunday("2026-09-12")).toBe("2026-09-06"); // Sat -> Sun
  });
  it("counts days between ISO dates", () => {
    expect(daysBetween("2026-09-08", "2026-09-11")).toBe(3);
  });
  it("flags special-run lanes", () => {
    expect(isSpecialRoute("BHM-SPECIAL")).toBe(true);
    expect(isSpecialRoute("MTN")).toBe(false);
  });
});

describe("metrics sign convention", () => {
  it("positive variance means the forecast ran HIGH", () => {
    const m = metricsOf([0.2, 0.2]);
    expect(m.bias).toBeCloseTo(0.2, 10);
    expect(m.mae).toBeCloseTo(0.2, 10);
  });

  it("negative variance means the forecast ran LOW and cancels in bias but not MAE", () => {
    const m = metricsOf([0.2, -0.2]);
    expect(m.bias).toBeCloseTo(0, 10);
    expect(m.mae).toBeCloseTo(0.2, 10);
  });

  it("tolerance shares are inclusive at the boundary", () => {
    const m = metricsOf([0.10, 0.15, 0.20, 0.30]);
    expect(m.within10).toBeCloseTo(0.25, 10);
    expect(m.within15).toBeCloseTo(0.5, 10);
    expect(m.within20).toBeCloseTo(0.75, 10);
  });

  it("n=0 yields nulls, not zeros", () => {
    expect(metricsOf([])).toEqual({
      n: 0, mae: null, bias: null, within5: null, within10: null, within15: null, within20: null,
      within5N: 0, within10N: 0,
    });
  });

  it("within5 share and within5N/within10N counts", () => {
    const m = metricsOf([0.03, -0.05, 0.07, -0.10, 0.12]);
    expect(m.within5N).toBe(2);
    expect(m.within10N).toBe(4);
    expect(m.within5).toBeCloseTo(0.4, 10);
    expect(m.within10).toBeCloseTo(0.8, 10);
  });

  it("float boundary: 0.65-0.55 is within 10, 0.62-0.57 is within 5, 0.101 is not within 10", () => {
    expect(metricsOf([0.65 - 0.55]).within10N).toBe(1);
    expect(metricsOf([0.62 - 0.57]).within5N).toBe(1);
    expect(metricsOf([0.101]).within10N).toBe(0);
  });
});

describe("readinessOf", () => {
  const withHits = (hits: number, n: number) =>
    metricsOf([...Array(hits).fill(0.02), ...Array(n - hits).fill(0.3)]);

  it("met at exactly 8 of 10", () => {
    expect(readinessOf(withHits(8, 10), 10)).toEqual({ status: "met", hits: 8, n: 10, rate: 0.8 });
  });
  it("below at 7 of 10", () => {
    expect(readinessOf(withHits(7, 10), 10).status).toBe("below");
  });
  it("insufficient at n=9 even with 9 hits", () => {
    expect(readinessOf(withHits(9, 9), 10)).toEqual({ status: "insufficient", hits: 9, n: 9, rate: 1 });
  });
  it("n=0 is insufficient with a null rate", () => {
    expect(readinessOf(metricsOf([]), 5)).toEqual({ status: "insufficient", hits: 0, n: 0, rate: null });
  });
  it("gate constant", () => {
    expect(READINESS_GATE).toEqual({ tolerancePts: 10, share: 0.8, label: "8 of every 10 runs within 10 points" });
  });
});

const run = (code: string, run_date: string, forecast: number, actual: number, hub = "Dallas"): ScoredRun => ({
  route_id: `id-${code}`, hub, code, run_date, week_start: weekStartSunday(run_date),
  forecast, actual, variance: forecast - actual,
});

describe("aggregate", () => {
  const rows = [
    run("MTN", "2026-09-08", 0.60, 0.77),   // -0.17
    run("MTN", "2026-09-09", 0.70, 0.70),   //  0.00
    run("DAL-LOCAL", "2026-09-09", 0.90, 0.70, "Dallas"), // +0.20
    run("BHM-A", "2026-08-05", 0.50, 0.40, "Birmingham"), // +0.10
  ];

  it("computes overall metrics on the variance", () => {
    const a = aggregate(rows);
    expect(a.overall.n).toBe(4);
    expect(a.overall.mae).toBeCloseTo((0.17 + 0 + 0.20 + 0.10) / 4, 10);
    expect(a.overall.bias).toBeCloseTo((-0.17 + 0 + 0.20 + 0.10) / 4, 10);
  });

  it("groups by route worst-first", () => {
    const a = aggregate(rows);
    expect(a.byRoute[0]!.code).toBe("DAL-LOCAL");
    expect(a.byRoute.find((r) => r.code === "MTN")!.n).toBe(2);
  });

  it("groups by hub", () => {
    const a = aggregate(rows);
    expect(a.byHub.map((h) => h.hub).sort()).toEqual(["Birmingham", "Dallas"]);
  });

  it("route-weeks average the runs in the week", () => {
    const w = byRouteWeek(rows).find((x) => x.code === "MTN")!;
    expect(w.days).toBe(2);
    expect(w.forecastMean).toBeCloseTo(0.65, 10);
    expect(w.actualMean).toBeCloseTo(0.735, 10);
    expect(w.varianceMean).toBeCloseTo(-0.085, 10);
    expect(w.mae).toBeCloseTo(0.085, 10);
  });

  it("weekLevel only counts route-weeks with 2+ runs; allWeeks counts them all", () => {
    const a = aggregate(rows);
    expect(a.weekLevel.n).toBe(1);
    expect(a.weekLevel.mae).toBeCloseTo(0.085, 10);
    expect(a.allWeeks.n).toBe(3);
  });
});
