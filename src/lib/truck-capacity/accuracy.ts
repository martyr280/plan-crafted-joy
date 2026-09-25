// Pure reconciliation logic for the "Forecast vs Tracker" tab.
//
// Question answered: for a route-day the branches logged in the tracker, what
// forecast did Nelson have in hand at the route's ORDER CUTOFF for that run?
// That is the number a dispatcher could have acted on, so it is the honest thing
// to score — not the freshest forecast, and not a forecast made after the truck
// was already committed.
//
// SIGN CONVENTION (same as score.ts): variance = forecast - actual.
// Positive = Nelson ran high; negative = Nelson ran low.
//
// Comparison unit is PERCENTAGE POINTS of a full truck. Fractions stay fractions
// in here (0.62); the UI/workbook multiplies by 100.
//
// No Supabase, no clock reads beyond what callers pass in.

import { addDaysISO, dowOfISO } from "./cutoffs";

/**
 * First date every route had a seeded forecast in truck_capacity_forecast_log.
 * UNCONFIRMED — chosen from the log's own history; revisit once the freeze has
 * been running for a few weeks and the early seeding period is behind us.
 */
export const ACCURACY_DEFAULT_MADE_FROM = "2026-07-31";

export type CutoffLite = {
  cutoff_dow: number;      // 0=Sun..6=Sat
  run_dows: number[];      // weekdays this cutoff feeds
  active?: boolean;
};

export type LogRowLite = {
  made_on: string;
  served: number | null;
  predicted: number | null;
  method: string | null;
  p21_guard_applied?: boolean | null;
};

/* ------------------------------- cutoff rule ------------------------------- */

/**
 * The cutoff calendar date that fed `runDate`: the LATEST date strictly before
 * runDate whose weekday matches a cutoff's cutoff_dow and whose run_dows include
 * runDate's weekday. Never returns a date on or after runDate.
 *
 * A route with no qualifying cutoff (special-run lanes have none; some runs land
 * on a weekday no cutoff feeds) falls back to runDate - 1 with cutoffKnown false,
 * so the row is still scored but visibly approximate.
 */
export function cutoffDateForRun(
  runDate: string,
  cutoffs: CutoffLite[],
): { cutoffDate: string; cutoffKnown: boolean } {
  const runDow = dowOfISO(runDate);
  let best: string | null = null;
  for (const c of cutoffs) {
    if (c.active === false) continue;
    if (!(c.run_dows ?? []).includes(runDow)) continue;
    for (let i = 1; i <= 7; i++) {
      const d = addDaysISO(runDate, -i);
      if (dowOfISO(d) === c.cutoff_dow) {
        if (!best || d > best) best = d;
        break;
      }
    }
  }
  if (!best) return { cutoffDate: addDaysISO(runDate, -1), cutoffKnown: false };
  return { cutoffDate: best, cutoffKnown: true };
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}

export type PickedForecast = {
  row: LogRowLite;
  madeOn: string;
  leadDays: number;
  afterCutoff: boolean;
};

/**
 * The forecast Nelson had at cutoff: largest made_on <= cutoffDate. If every
 * logged forecast for this run landed after the cutoff, take the earliest one
 * before the run date and flag afterCutoff so the UI can discount it. Forecasts
 * made on or after the run date are never used.
 */
export function pickForecastAtCutoff(
  logRows: LogRowLite[],
  cutoffDate: string,
  runDate: string,
): PickedForecast | null {
  const before = logRows.filter((r) => r.made_on < runDate && r.served != null);
  if (!before.length) return null;
  const atCutoff = before.filter((r) => r.made_on <= cutoffDate);
  let chosen: LogRowLite;
  let afterCutoff: boolean;
  if (atCutoff.length) {
    chosen = atCutoff.reduce((a, b) => (b.made_on > a.made_on ? b : a));
    afterCutoff = false;
  } else {
    chosen = before.reduce((a, b) => (b.made_on < a.made_on ? b : a));
    afterCutoff = true;
  }
  return { row: chosen, madeOn: chosen.made_on, leadDays: daysBetween(chosen.made_on, runDate), afterCutoff };
}

/* ------------------------------- aggregation ------------------------------- */

/** Sunday-anchored week start, same convention as the Overview heatmap. */
export function weekStartSunday(dateISO: string): string {
  return addDaysISO(dateISO, -dowOfISO(dateISO));
}

export type ScoredRun = {
  route_id: string;
  hub: string | null;
  code: string;
  run_date: string;
  week_start: string;
  forecast: number;
  actual: number;
  variance: number;
};

export type AccuracyMetrics = {
  n: number;
  mae: number | null;
  bias: number | null;
  within5: number | null;
  within10: number | null;
  within15: number | null;
  within20: number | null;
  /** Scored runs behind within5 / within10 (0 when n=0). */
  within5N: number;
  within10N: number;
};

/** Float-safe tolerance test in whole points: |0.65-0.55| counts as within 10. */
export function withinPts(variance: number, tolPts: number): boolean {
  return Math.abs(variance) * 100 <= tolPts + 1e-9;
}

/** n=0 yields nulls for rates and 0 for counts, never NaN and never a fabricated zero. */
export function metricsOf(variances: number[]): AccuracyMetrics {
  if (!variances.length) {
    return { n: 0, mae: null, bias: null, within5: null, within10: null, within15: null, within20: null, within5N: 0, within10N: 0 };
  }
  const n = variances.length;
  const hits = (tol: number) => variances.filter((v) => withinPts(v, tol)).length;
  const within5N = hits(5);
  const within10N = hits(10);
  return {
    n,
    mae: variances.reduce((s, v) => s + Math.abs(v), 0) / n,
    bias: variances.reduce((s, v) => s + v, 0) / n,
    within5: within5N / n,
    within10: within10N / n,
    within15: hits(15) / n,
    within20: hits(20) / n,
    within5N,
    within10N,
  };
}

export const READINESS_GATE = { tolerancePts: 10, share: 0.8, label: "8 of every 10 runs within 10 points" } as const;

// UNCONFIRMED — minimum sample for a verdict is Marty's call, not the customer's.
export const READINESS_MIN_RUNS = 10;

export type ReadinessStatus = "met" | "below" | "insufficient";
export type Readiness = { status: ReadinessStatus; hits: number; n: number; rate: number | null };

export function readinessOf(m: AccuracyMetrics, tolerancePts: 5 | 10): Readiness {
  const n = m.n;
  const hits = tolerancePts === 5 ? m.within5N : m.within10N;
  const rate = n > 0 ? hits / n : null;
  if (n < READINESS_MIN_RUNS) return { status: "insufficient", hits, n, rate };
  // Integer comparison: hits >= share*n, float-safe so 8 of 10 is met.
  const met = hits + 1e-9 >= READINESS_GATE.share * n;
  return { status: met ? "met" : "below", hits, n, rate };
}

export const READINESS_LABEL: Record<ReadinessStatus, string> = {
  met: "Met",
  below: "Below gate",
  insufficient: "Too few runs (n<10)",
};

export type ReadinessRow = {
  hub: string;
  n: number;
  within5N: number;
  within5: number | null;
  within10N: number;
  within10: number | null;
  at10: Readiness;
  at5: Readiness;
};

export function readinessRow(hub: string, m: AccuracyMetrics): ReadinessRow {
  return {
    hub, n: m.n, within5N: m.within5N, within5: m.within5, within10N: m.within10N, within10: m.within10,
    at10: readinessOf(m, 10), at5: readinessOf(m, 5),
  };
}

/** Hubs in HUB_ORDER first, then alphabetically. */
export const HUB_ORDER = ["Dallas", "Birmingham", "Ocala"];
export function sortHubs(hubs: string[]): string[] {
  return [...hubs].sort((a, b) => {
    const ia = HUB_ORDER.indexOf(a), ib = HUB_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
}

export type RouteWeek = {
  route_id: string;
  code: string;
  hub: string | null;
  week_start: string;
  days: number;
  forecastMean: number;
  actualMean: number;
  varianceMean: number;
  mae: number;
};

export function byRouteWeek(rows: ScoredRun[]): RouteWeek[] {
  const acc = new Map<string, ScoredRun[]>();
  for (const r of rows) {
    const k = `${r.route_id}|${r.week_start}`;
    acc.set(k, [...(acc.get(k) ?? []), r]);
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return Array.from(acc.values())
    .map((g) => ({
      route_id: g[0]!.route_id,
      code: g[0]!.code,
      hub: g[0]!.hub,
      week_start: g[0]!.week_start,
      days: g.length,
      forecastMean: mean(g.map((r) => r.forecast)),
      actualMean: mean(g.map((r) => r.actual)),
      varianceMean: mean(g.map((r) => r.variance)),
      mae: mean(g.map((r) => Math.abs(r.variance))),
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || a.code.localeCompare(b.code));
}

export type AccuracyAggregates = {
  overall: AccuracyMetrics;
  byRoute: Array<{ route_id: string; code: string; hub: string | null } & AccuracyMetrics>;
  byHub: Array<{ hub: string | null } & AccuracyMetrics>;
  routeWeeks: RouteWeek[];
  /** Metrics over route-weeks with 2+ scored runs — the level Joe reviews. */
  weekLevel: AccuracyMetrics;
  /** Same, over every route-week regardless of run count. */
  allWeeks: AccuracyMetrics;
};

export function aggregate(rows: ScoredRun[]): AccuracyAggregates {
  const groupBy = <K>(keyOf: (r: ScoredRun) => K) => {
    const m = new Map<string, { key: K; rows: ScoredRun[] }>();
    for (const r of rows) {
      const key = keyOf(r);
      const k = String(key);
      const cur = m.get(k) ?? { key, rows: [] };
      cur.rows.push(r);
      m.set(k, cur);
    }
    return Array.from(m.values());
  };

  const routeWeeks = byRouteWeek(rows);

  return {
    overall: metricsOf(rows.map((r) => r.variance)),
    byRoute: groupBy((r) => r.route_id)
      .map((g) => ({
        route_id: g.rows[0]!.route_id,
        code: g.rows[0]!.code,
        hub: g.rows[0]!.hub,
        ...metricsOf(g.rows.map((r) => r.variance)),
      }))
      .sort((a, b) => (b.mae ?? -1) - (a.mae ?? -1)),
    byHub: groupBy((r) => r.hub ?? "")
      .map((g) => ({ hub: g.rows[0]!.hub, ...metricsOf(g.rows.map((r) => r.variance)) }))
      .sort((a, b) => (b.mae ?? -1) - (a.mae ?? -1)),
    routeWeeks,
    weekLevel: metricsOf(routeWeeks.filter((w) => w.days >= 2).map((w) => w.varianceMean)),
    allWeeks: metricsOf(routeWeeks.map((w) => w.varianceMean)),
  };
}

/** Whole percentage points, for the UI and the workbook. */
export function pts(frac: number | null | undefined, decimals = 0): string {
  if (frac == null || !Number.isFinite(Number(frac))) return "—";
  return (Number(frac) * 100).toFixed(decimals);
}

export function isSpecialRoute(code: string): boolean {
  return code.toUpperCase().includes("SPECIAL");
}
