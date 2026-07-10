// Serving forecast: loads promoted model version, blends with baseline,
// applies P21 max-guard, returns per-day forecast with driver breakdown.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { clamp, predict as vecPredict, mad as madFn } from "./linalg";
import { baselineFromSnapshot, addDaysISO, dowOf, monthOf, type BaselineDay, type RunPoint } from "./baseline";
import {
  buildFeatureContext, buildFeatureRow, buildLagBlock, featureNames,
  type RouteMeta,
} from "./features";
import { groupContributions, driverSummary } from "./explain";

export type ServingMethod = "auto" | "baseline" | "model";

export type ForecastDay = {
  date: string;
  dow: number;
  baseline: number | null;
  seasonal: number;
  forecast: number | null;   // baseline forecast (legacy field)
  model: number | null;
  blend: number | null;
  mad: number;
  p21: number | null;
  final: number | null;      // served value; equals max(chosenPredictor, p21)
  method: "baseline" | "model" | "blend";
  n_baseline: number;
  explain: string;
  driverSummary?: string;
};

export type ForecastResponse = {
  route: any | null;
  days: ForecastDay[];
  servingMethod: "baseline" | "model" | "blend";
  version: {
    id: string; trained_at: string; lambda: number; blend_w: number;
    holdout_mae_baseline: number | null; holdout_mae_model: number | null;
    holdout_mae_blend: number | null; promoted: boolean;
  } | null;
};

async function loadPromotedVersion() {
  const { data } = await supabaseAdmin
    .from("truck_capacity_model_versions")
    .select("id, trained_at, coefficients, feature_names, lambda, blend_w, holdout_mae_baseline, holdout_mae_model, holdout_mae_blend, per_route_residual_mad, promoted")
    .eq("promoted", true)
    .order("trained_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function loadLatestVersion() {
  const { data } = await supabaseAdmin
    .from("truck_capacity_model_versions")
    .select("id, trained_at, coefficients, feature_names, lambda, blend_w, holdout_mae_baseline, holdout_mae_model, holdout_mae_blend, per_route_residual_mad, promoted")
    .order("trained_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function loadAllRoutesMeta(): Promise<RouteMeta[]> {
  const { data } = await supabaseAdmin
    .from("truck_capacity_routes").select("id, code, hub, truck_type");
  return (data ?? []) as RouteMeta[];
}

async function loadRouteRunsSince(routeId: string, sinceISO: string): Promise<RunPoint[]> {
  const { data } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("run_date, capacity_frac")
    .eq("route_id", routeId)
    .gte("run_date", sinceISO)
    .order("run_date", { ascending: true })
    .limit(3000);
  return (data ?? []).map((r) => ({ date: r.run_date, cap: Number(r.capacity_frac) }));
}

async function loadHubRunsSince(hub: string, sinceISO: string): Promise<RunPoint[]> {
  const { data } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("run_date, capacity_frac, truck_capacity_routes!inner(hub)")
    .eq("truck_capacity_routes.hub", hub)
    .gte("run_date", sinceISO)
    .limit(20000);
  return (data ?? []).map((r: any) => ({ date: r.run_date, cap: Number(r.capacity_frac) }));
}

async function loadP21Latest(routeId: string, from: string, to: string): Promise<Map<string, number>> {
  const { data } = await supabaseAdmin
    .from("truck_capacity_p21_demand")
    .select("ship_date, projected_capacity_frac, snapshot_at")
    .eq("route_id", routeId)
    .gte("ship_date", from)
    .lte("ship_date", to)
    .order("snapshot_at", { ascending: false });
  const latest = new Map<string, number>();
  for (const p of data ?? []) {
    if (!latest.has(p.ship_date)) latest.set(p.ship_date, Number(p.projected_capacity_frac ?? 0));
  }
  return latest;
}

export async function computeForecastForRoute(
  routeId: string,
  horizonDays = 28,
  methodOverride: ServingMethod = "auto",
): Promise<ForecastResponse> {
  const { data: route } = await supabaseAdmin
    .from("truck_capacity_routes").select("*").eq("id", routeId).maybeSingle();
  if (!route) return { route: null, days: [], servingMethod: "baseline", version: null };

  const today = new Date().toISOString().slice(0, 10);
  const from = addDaysISO(today, -84);
  const horizonEnd = addDaysISO(today, horizonDays);

  const [routeRunsData, hubRunsData, p21Latest] = await Promise.all([
    loadRouteRunsSince(routeId, from),
    loadHubRunsSince(route.hub, from),
    loadP21Latest(routeId, today, horizonEnd),
  ]);

  const baselineDays = baselineFromSnapshot(
    routeRunsData,
    hubRunsData.map((r) => r.cap),
    today,
    horizonDays,
    route.typical_dow ?? [],
  );

  // Decide serving method.
  const promoted = methodOverride === "baseline" ? null : await (methodOverride === "model" ? loadLatestVersion() : loadPromotedVersion());
  const useModel = !!promoted && methodOverride !== "baseline";

  let ctxRoutes: RouteMeta[] = [];
  let names: string[] = [];
  let allRunsForCtx: { date: string }[] = [];
  let allRouteHubRuns: RunPoint[] = [];
  if (useModel && promoted) {
    ctxRoutes = await loadAllRoutesMeta();
    // Fetch min run_date for trend feature — cheap single row.
    const { data: minRow } = await supabaseAdmin
      .from("truck_capacity_runs").select("run_date").order("run_date", { ascending: true }).limit(1).maybeSingle();
    allRunsForCtx = minRow ? [{ date: minRow.run_date }] : [];
    names = promoted.feature_names as any;
    void names;
    // Load extended history for this route + hub for lag freshness.
    const from56 = addDaysISO(today, -56);
    const [routeHist, hubHist] = await Promise.all([
      loadRouteRunsSince(routeId, from56),
      loadHubRunsSince(route.hub, from56),
    ]);
    allRouteHubRuns = hubHist;
    routeRunsData.splice(0, routeRunsData.length, ...routeHist);
    hubRunsData.splice(0, hubRunsData.length, ...hubHist);
  }

  const routeMeta: RouteMeta = { id: route.id, code: route.code, hub: route.hub, truck_type: route.truck_type };
  const ctx = useModel ? buildFeatureContext(ctxRoutes.length > 0 ? ctxRoutes : [routeMeta], allRunsForCtx) : null;

  const perRouteResidMad = (promoted as any)?.per_route_residual_mad ?? {};
  const routeMadOverride: number | undefined = perRouteResidMad?.[routeId];

  const days: ForecastDay[] = baselineDays.map((b: BaselineDay) => {
    const p21 = p21Latest.get(b.date) ?? null;
    let modelPred: number | null = null;
    let blend: number | null = null;
    let method: "baseline" | "model" | "blend" = "baseline";
    let driverStr: string | undefined;

    if (useModel && promoted && ctx) {
      const lags = buildLagBlock(routeRunsData, allRouteHubRuns, today, b.date);
      const x = buildFeatureRow(ctx, routeMeta, b.date, lags);
      const coeffs = promoted.coefficients as any as number[];
      // Guard against feature-count drift after a schema change: fall back to
      // baseline if lengths don't match.
      if (Array.isArray(coeffs) && coeffs.length === x.length) {
        modelPred = clamp(vecPredict(x, coeffs), 0, 1.25);
        const w = Number(promoted.blend_w ?? 0);
        const baseVal = b.forecast ?? modelPred;
        blend = clamp(w * modelPred + (1 - w) * baseVal, 0, 1.25);
        method = w >= 0.999 ? "model" : (w <= 0.001 ? "baseline" : "blend");
        const groups = groupContributions(coeffs, promoted.feature_names as any, x);
        driverStr = driverSummary(groups, p21 != null && p21 > (blend ?? 0));
      }
    }

    const chosen = useModel && blend != null ? blend : (b.forecast ?? null);
    const final = chosen == null ? p21 : (p21 != null ? Math.max(chosen, p21) : chosen);
    const madVal = routeMadOverride ?? b.mad;
    const explainSuffix = driverStr ? ` · ${driverStr}` : "";
    const p21Suffix = p21 != null ? ` · P21 ${p21.toFixed(2)}` : "";
    return {
      date: b.date, dow: b.dow, baseline: b.baseline, seasonal: b.seasonal,
      forecast: b.forecast, model: modelPred, blend, mad: madVal, p21, final,
      method: useModel && chosen === blend ? method : "baseline",
      n_baseline: b.n_baseline,
      explain: `${b.explain}${p21Suffix}${explainSuffix}`,
      driverSummary: driverStr,
    };
  });

  // Best-effort forecast_log write (dedup by unique index).
  if (useModel && promoted) {
    try {
      const rows = days.filter((d) => d.final != null).map((d) => ({
        route_id: routeId,
        forecast_date: d.date,
        made_on: today,
        predicted: d.final!,
        method: d.method,
        model_version_id: promoted.id,
      }));
      if (rows.length > 0) {
        await supabaseAdmin.from("truck_capacity_forecast_log")
          .upsert(rows, { onConflict: "route_id,forecast_date,made_on,method", ignoreDuplicates: true });
      }
    } catch { /* best-effort */ }
  }

  const servingMethod: "baseline" | "model" | "blend" = useModel
    ? (Number(promoted?.blend_w ?? 0) >= 0.999 ? "model" : (Number(promoted?.blend_w ?? 0) <= 0.001 ? "baseline" : "blend"))
    : "baseline";

  const versionOut = promoted ? {
    id: promoted.id, trained_at: promoted.trained_at,
    lambda: Number(promoted.lambda), blend_w: Number(promoted.blend_w),
    holdout_mae_baseline: promoted.holdout_mae_baseline == null ? null : Number(promoted.holdout_mae_baseline),
    holdout_mae_model: promoted.holdout_mae_model == null ? null : Number(promoted.holdout_mae_model),
    holdout_mae_blend: promoted.holdout_mae_blend == null ? null : Number(promoted.holdout_mae_blend),
    promoted: promoted.promoted,
  } : null;
  void dowOf; void monthOf; void madFn;
  return { route, days, servingMethod, version: versionOut };
}
