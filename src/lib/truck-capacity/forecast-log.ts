// Pure helpers for truck_capacity_forecast_log rows.
//
// Both writers (the in-serve best-effort write in serve.ts and the nightly/manual
// freeze in freeze.ts) build rows through forecastLogRowsFromDays so the logged
// shape is identical regardless of which path produced it.

export type ForecastLogRow = {
  route_id: string;
  forecast_date: string;
  made_on: string;
  predicted: number;
  served: number;
  p21_guard_applied: boolean;
  method: "baseline" | "model" | "blend";
  model_version_id: string | null;
};

type DayLike = {
  date: string;
  blend: number | null;
  forecast: number | null;
  p21: number | null;
  final: number | null;
  method: "baseline" | "model" | "blend";
};

/**
 * `predicted` is the pre-guard prediction (blend when the model voted, otherwise
 * the baseline forecast). `served` is what the board showed, i.e. post-P21-guard.
 * Days with no served value are not logged at all.
 */
export function forecastLogRowsFromDays(
  routeId: string,
  days: DayLike[],
  madeOn: string,
  modelVersionId: string | null,
): ForecastLogRow[] {
  const rows: ForecastLogRow[] = [];
  for (const d of days) {
    if (d.final == null || !Number.isFinite(Number(d.final))) continue;
    const raw = d.blend ?? d.forecast;
    if (raw == null || !Number.isFinite(Number(raw))) continue;
    const predicted = Number(raw);
    const p21 = d.p21 == null ? null : Number(d.p21);
    rows.push({
      route_id: routeId,
      forecast_date: d.date,
      made_on: madeOn,
      predicted,
      served: Number(d.final),
      p21_guard_applied: p21 != null && p21 > predicted,
      method: d.method,
      model_version_id: modelVersionId,
    });
  }
  return rows;
}

const METHOD_RANK: Record<string, number> = { blend: 0, model: 1, baseline: 2 };

/**
 * One row per (route_id, forecast_date, made_on). Preference: blend > model >
 * baseline; unknown/null methods rank last. Prevents double-counting the same
 * forecast once more than one method is logged for a key.
 */
export function dedupeLogRows<T extends { route_id: string; forecast_date: string; made_on: string; method: string | null }>(
  rows: T[],
): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.route_id}|${r.forecast_date}|${r.made_on}`;
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    const rank = (m: string | null) => (m != null && m in METHOD_RANK ? METHOD_RANK[m]! : 99);
    if (rank(r.method) < rank(cur.method)) best.set(key, r);
  }
  return Array.from(best.values());
}
