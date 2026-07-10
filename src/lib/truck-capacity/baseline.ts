// Pure baseline forecast: trimmed-mean × seasonal, no DB access.
// Mirrors the historical live behavior. Used by the DB-reading wrapper AND
// by the backtest (which must recompute baseline "as of" each cutoff).

import { mean as meanFn, mad as madFn, clamp } from "./linalg";

export type RunPoint = { date: string; cap: number };

export type BaselineDay = {
  date: string;
  dow: number;
  baseline: number | null;
  seasonal: number;
  forecast: number | null;
  mad: number;
  n_baseline: number;
  explain: string;
};

const WK = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function addDaysISO(iso: string, d: number): string {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + d);
  return dt.toISOString().slice(0, 10);
}
export function dowOf(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}
export function monthOf(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCMonth() + 1;
}

function trimmedMean(nums: number[], trimPct = 0.1): number | null {
  if (nums.length === 0) return null;
  if (nums.length < 3) return nums.reduce((a, b) => a + b, 0) / nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * trimPct);
  const kept = sorted.slice(drop, sorted.length - drop);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/**
 * Compute the baseline forecast for a route, given the route's runs and the
 * hub pool of runs. All inputs are "as of" `asOf` (caller must pre-filter).
 *
 *  - Weekday pattern window: 84 days back
 *  - Trimmed-mean baseline window: 56 days back per (route, weekday)
 *  - Fallback chain: route weekday trimmed → route mean → hub mean → 0.5
 *  - Seasonal: per-calendar-month factor with (n·raw + 4)/(n+4) shrinkage
 *  - Bands: ±1 MAD of trailing route values
 */
export function baselineFromSnapshot(
  routeRuns: RunPoint[],
  hubRuns: number[],
  asOf: string,
  horizonDays: number,
  typicalDow: number[] = [],
): BaselineDay[] {
  const from84 = addDaysISO(asOf, -84);
  const from56 = addDaysISO(asOf, -56);
  const trailing = routeRuns.filter((r) => r.date >= from84 && r.date < asOf);

  // Weekday histogram — need ≥2 samples on a DoW to consider it "typical".
  const dowHist = new Map<number, number>();
  for (const r of trailing) dowHist.set(dowOf(r.date), (dowHist.get(dowOf(r.date)) ?? 0) + 1);
  const activeDows = new Set<number>();
  for (const [d, n] of dowHist) if (n >= 2) activeDows.add(d);
  if (activeDows.size === 0) typicalDow.forEach((d) => activeDows.add(d));

  // Per-weekday samples over 56d
  const byDow = new Map<number, number[]>();
  const routeVals56: number[] = [];
  for (const r of trailing) {
    if (r.date < from56) continue;
    routeVals56.push(r.cap);
    const d = dowOf(r.date);
    const arr = byDow.get(d) ?? [];
    arr.push(r.cap);
    byDow.set(d, arr);
  }
  const routeMean = routeVals56.length > 0 ? meanFn(routeVals56) : null;
  const hubMeanVal = hubRuns.length > 0 ? meanFn(hubRuns) : 0.5;
  const overallMean = trailing.length > 0 ? meanFn(trailing.map((r) => r.cap)) : null;

  // Monthly factors — computed once from trailing window, indexed by target month
  const monthFactor = new Map<number, { factor: number; n: number }>();
  for (let m = 1; m <= 12; m++) {
    const vals = trailing.filter((r) => monthOf(r.date) === m).map((r) => r.cap);
    const raw = overallMean && overallMean > 0 && vals.length > 0 ? (meanFn(vals) / overallMean) : 1.0;
    const shrunk = (vals.length * raw + 4 * 1.0) / (vals.length + 4);
    monthFactor.set(m, { factor: shrunk, n: vals.length });
  }

  const madVal = madFn(routeVals56);
  const days: BaselineDay[] = [];
  for (let i = 1; i <= horizonDays; i++) {
    const date = addDaysISO(asOf, i);
    const dw = dowOf(date);
    const mo = monthOf(date);
    const mf = monthFactor.get(mo) ?? { factor: 1.0, n: 0 };
    const seasonal = mf.factor;
    if (!activeDows.has(dw)) {
      // Emit null baseline; serving layer decides whether to force a value.
      days.push({
        date, dow: dw, baseline: null, seasonal, forecast: null,
        mad: madVal, n_baseline: 0,
        explain: `No baseline (route does not typically run this weekday).`,
      });
      continue;
    }
    const samples = byDow.get(dw) ?? [];
    const base = trimmedMean(samples) ?? routeMean ?? hubMeanVal ?? 0.5;
    const forecast = clamp(base * seasonal, 0, 1.25);
    days.push({
      date, dow: dw, baseline: base, seasonal, forecast,
      mad: madVal, n_baseline: samples.length,
      explain: `${WK[dw]} baseline ${base.toFixed(2)} (n=${samples.length}) × ${MON[mo - 1]} ${seasonal.toFixed(2)} = ${forecast.toFixed(2)}`,
    });
  }
  return days;
}

/**
 * Single-day baseline point-forecast for backtest / retrain evaluation.
 * Returns 0.5 fallback if no signal at all (never null — model training needs a number).
 */
export function baselinePoint(
  routeRuns: RunPoint[],
  hubRuns: number[],
  targetDate: string,
  typicalDow: number[] = [],
): number {
  // Compute using an asOf right before the target date.
  const asOf = targetDate;
  const days = baselineFromSnapshot(routeRuns, hubRuns, addDaysISO(asOf, -1), 1, typicalDow);
  // days[0] corresponds to asOf itself (offset +1 from -1). Convert:
  const d = days.find((x) => x.date === targetDate);
  if (d?.forecast != null) return d.forecast;
  // Fallback: even if not a "typical" weekday, use last-resort baseline chain.
  const from56 = addDaysISO(asOf, -56);
  const vals56 = routeRuns.filter((r) => r.date >= from56 && r.date < asOf).map((r) => r.cap);
  if (vals56.length > 0) return meanFn(vals56);
  if (hubRuns.length > 0) return meanFn(hubRuns);
  return 0.5;
}
