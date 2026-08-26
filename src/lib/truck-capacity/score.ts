// Forecast-vs-actual scoring for logged predictions.
//
// This is NOT the holdout backtest MAE stored on truck_capacity_model_versions.
// Here we score what the board actually showed (`served`) against what really
// happened, joined strictly on (route_id, forecast_date = run_date). No date
// fuzzing, no nearest-day fallback: an unscored forecast stays unscored.
//
// ACTUAL DEFINITION: the actual for a (route, date) is avg(capacity_frac) across
// every run_seq row for that route-day. A route with a Run 2 is averaged, never
// double-counted and never silently dropped.
//
// SIGN CONVENTION: error = served - actual, so a POSITIVE bias means the
// forecast ran high (over-forecast).

export type ScoreInput = {
  routeId: string;
  forecastDate: string; // YYYY-MM-DD
  madeOn: string; // YYYY-MM-DD
  served: number;
  predicted: number | null;
  actual: number;
};

export type LeadBucket = "0-2" | "3-7" | "8-14" | "15+";
export const LEAD_BUCKETS: LeadBucket[] = ["0-2", "3-7", "8-14", "15+"];

export function leadTimeDays(forecastDate: string, madeOn: string): number {
  return Math.round(
    (Date.parse(`${forecastDate}T00:00:00Z`) - Date.parse(`${madeOn}T00:00:00Z`)) / 86_400_000,
  );
}

export function leadBucket(leadDays: number): LeadBucket {
  if (leadDays <= 2) return "0-2";
  if (leadDays <= 7) return "3-7";
  if (leadDays <= 14) return "8-14";
  return "15+";
}

/** avg(capacity_frac) per (route_id, run_date). Rows with a null frac are ignored. */
export function actualsByRouteDay(
  runs: Array<{ route_id: string; run_date: string; capacity_frac: number | null }>,
): Map<string, number> {
  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of runs) {
    if (r.capacity_frac == null || !Number.isFinite(Number(r.capacity_frac))) continue;
    const k = `${r.route_id}|${r.run_date}`;
    const cur = acc.get(k) ?? { sum: 0, n: 0 };
    cur.sum += Number(r.capacity_frac);
    cur.n += 1;
    acc.set(k, cur);
  }
  const out = new Map<string, number>();
  for (const [k, v] of acc) out.set(k, v.sum / v.n);
  return out;
}

export type Metrics = { n: number; mae: number | null; bias: number | null; predictedMae: number | null };

/** n=0 yields nulls, never NaN and never a fabricated zero. */
export function metricsOf(rows: ScoreInput[]): Metrics {
  if (!rows.length) return { n: 0, mae: null, bias: null, predictedMae: null };
  let absSum = 0;
  let signedSum = 0;
  let pAbsSum = 0;
  let pN = 0;
  for (const r of rows) {
    const e = r.served - r.actual;
    absSum += Math.abs(e);
    signedSum += e;
    if (r.predicted != null && Number.isFinite(r.predicted)) {
      pAbsSum += Math.abs(r.predicted - r.actual);
      pN += 1;
    }
  }
  return {
    n: rows.length,
    mae: absSum / rows.length,
    bias: signedSum / rows.length,
    predictedMae: pN ? pAbsSum / pN : null,
  };
}

export type ScoreSummary = {
  overall: Metrics;
  byBucket: Array<{ bucket: LeadBucket } & Metrics>;
  byRoute: Array<{ routeId: string } & Metrics>;
};

/**
 * Every (route, forecast_date, made_on) row is kept — the repeated predictions at
 * different lead times ARE the lead-time analysis, so no collapsing to one row
 * per route-day.
 */
export function summarize(rows: ScoreInput[]): ScoreSummary {
  const byBucket = LEAD_BUCKETS.map((bucket) => ({
    bucket,
    ...metricsOf(rows.filter((r) => leadBucket(leadTimeDays(r.forecastDate, r.madeOn)) === bucket)),
  }));

  const routeIds = Array.from(new Set(rows.map((r) => r.routeId)));
  const byRoute = routeIds
    .map((routeId) => ({ routeId, ...metricsOf(rows.filter((r) => r.routeId === routeId)) }))
    .sort((a, b) => (b.mae ?? -1) - (a.mae ?? -1));

  return { overall: metricsOf(rows), byBucket, byRoute };
}
