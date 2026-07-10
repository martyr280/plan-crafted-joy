// Feature-vector builder for the ridge learner. Feature order is stable and
// stored on the model version row so serving reproduces training exactly.

import type { RunPoint } from "./baseline";
import { dowOf, monthOf, addDaysISO } from "./baseline";
import { mean as meanFn } from "./linalg";

export type RouteMeta = {
  id: string;
  code: string;
  hub: string;
  truck_type: string | null;
};

export type FeatureContext = {
  routes: RouteMeta[];                     // sorted deterministically
  hubs: string[];                          // deterministic
  minRunDateISO: string | null;            // for trend feature
};

export function buildFeatureContext(routes: RouteMeta[], allRuns: { date: string }[]): FeatureContext {
  const hubsSet = new Set<string>();
  for (const r of routes) hubsSet.add(r.hub);
  const hubs = [...hubsSet].sort();
  const sortedRoutes = [...routes].sort((a, b) => a.id.localeCompare(b.id));
  const dates = allRuns.map((r) => r.date).sort();
  return { routes: sortedRoutes, hubs, minRunDateISO: dates[0] ?? null };
}

// --- lag helpers -----------------------------------------------------------

function ewMean(vals: number[], halflifeRuns: number): number | null {
  // Reverse-chronological order expected: vals[0] is most recent.
  if (vals.length === 0) return null;
  const decay = Math.pow(0.5, 1 / halflifeRuns);
  let num = 0;
  let den = 0;
  let w = 1;
  for (const v of vals) {
    num += w * v;
    den += w;
    w *= decay;
  }
  return num / den;
}

function trimmedMean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  if (nums.length < 3) return nums.reduce((a, b) => a + b, 0) / nums.length;
  const s = [...nums].sort((a, b) => a - b);
  const drop = Math.floor(s.length * 0.1);
  const kept = s.slice(drop, s.length - drop);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

// --- lag block -------------------------------------------------------------

export type LagBlock = {
  ewMean: number;
  lastRun: number;
  sameWeekdayMean: number;
  overallMean56: number;
  runCountNorm: number;   // min(runs, 30) / 30
  missingHistory: number; // 1 if <2 runs
  hubTrailing28: number;
};

export function buildLagBlock(
  routeRuns: RunPoint[],
  hubRuns: RunPoint[],
  asOf: string,
  targetDate: string,
): LagBlock {
  const past = routeRuns.filter((r) => r.date < asOf);
  const from56 = addDaysISO(asOf, -56);
  const from28 = addDaysISO(asOf, -28);
  const past56 = past.filter((r) => r.date >= from56);
  const tgtDow = dowOf(targetDate);

  const sortedDesc = [...past].sort((a, b) => b.date.localeCompare(a.date));
  const ewValues = sortedDesc.slice(0, 20).map((r) => r.cap); // enough for halflife=5
  const ew = ewMean(ewValues, 5);

  const sameDow = past56.filter((r) => dowOf(r.date) === tgtDow).map((r) => r.cap);
  const swMean = sameDow.length >= 2 ? (trimmedMean(sameDow) ?? 0) : 0;

  const overall56 = past56.length > 0 ? meanFn(past56.map((r) => r.cap)) : 0;
  const hub28 = hubRuns.filter((r) => r.date >= from28 && r.date < asOf).map((r) => r.cap);
  const hubMean28 = hub28.length > 0 ? meanFn(hub28) : 0;

  return {
    ewMean: ew ?? 0,
    lastRun: sortedDesc[0]?.cap ?? 0,
    sameWeekdayMean: swMean,
    overallMean56: overall56,
    runCountNorm: Math.min(past.length, 30) / 30,
    missingHistory: past.length < 2 ? 1 : 0,
    hubTrailing28: hubMean28,
  };
}

// --- full feature vector ---------------------------------------------------

export function featureNames(ctx: FeatureContext): string[] {
  const names: string[] = ["intercept"];
  for (let d = 1; d <= 6; d++) names.push(`dow_${d}`); // Mon..Sat
  for (let m = 2; m <= 12; m++) names.push(`month_${m}`);
  for (const h of ctx.hubs.slice(1)) names.push(`hub_${h}`); // hub 0 = reference
  names.push("truck_box");
  names.push("trend_years");
  names.push("lag_ew");
  names.push("lag_last");
  names.push("lag_sameweekday");
  names.push("lag_overall56");
  names.push("lag_runcount");
  names.push("lag_missing");
  names.push("lag_hub28");
  for (const r of ctx.routes.slice(1)) names.push(`route_${r.code}`);
  return names;
}

export function buildFeatureRow(
  ctx: FeatureContext,
  route: RouteMeta,
  targetDate: string,
  lags: LagBlock,
): number[] {
  const x: number[] = [1]; // intercept
  const dw = dowOf(targetDate);
  for (let d = 1; d <= 6; d++) x.push(dw === d ? 1 : 0);
  const mo = monthOf(targetDate);
  for (let m = 2; m <= 12; m++) x.push(mo === m ? 1 : 0);
  const hubRef = ctx.hubs[0];
  for (const h of ctx.hubs.slice(1)) x.push(route.hub === h ? 1 : 0);
  void hubRef;
  x.push(route.truck_type === "box_truck" ? 1 : 0);
  // Trend: days_since_first_run / 365
  const t0 = ctx.minRunDateISO;
  if (t0) {
    const ms = new Date(targetDate + "T00:00:00Z").getTime() - new Date(t0 + "T00:00:00Z").getTime();
    x.push(ms / (1000 * 60 * 60 * 24 * 365));
  } else {
    x.push(0);
  }
  x.push(lags.ewMean);
  x.push(lags.lastRun);
  x.push(lags.sameWeekdayMean);
  x.push(lags.overallMean56);
  x.push(lags.runCountNorm);
  x.push(lags.missingHistory);
  x.push(lags.hubTrailing28);
  const routeRef = ctx.routes[0]?.id;
  for (const r of ctx.routes.slice(1)) x.push(route.id === r.id ? 1 : 0);
  void routeRef;
  return x;
}
