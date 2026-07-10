// trainAndMaybePromote(): pull all runs, run the backtest, persist a version
// row, flip `promoted` if blend holdout MAE < baseline holdout MAE.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { rollingOriginBacktest, buildMonthlyCutoffs, type RouteDay } from "./backtest";
import type { RouteMeta } from "./features";

export type TrainSummary = {
  ok: boolean;
  version_id?: string;
  promoted?: boolean;
  chosenLambda?: number;
  chosenW?: number;
  train_rows?: number;
  holdout_mae_baseline?: number;
  holdout_mae_model?: number;
  holdout_mae_blend?: number;
  wape_baseline?: number;
  wape_model?: number;
  wape_blend?: number;
  per_route_mae?: Record<string, { baseline: number; model: number; blend: number; n: number }>;
  error?: string;
  fold_count?: number;
};

const LAMBDA_GRID = [0.3, 1, 3, 10, 30, 100];
const W_GRID = [0, 0.3, 0.5, 0.7, 1.0];
const HORIZON = 28;

async function fetchAllRuns(): Promise<Array<{ route_id: string; run_date: string; capacity_frac: number }>> {
  const all: any[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("truck_capacity_runs")
      .select("route_id, run_date, capacity_frac")
      .order("run_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function aggregateToRouteDay(runs: Array<{ route_id: string; run_date: string; capacity_frac: number }>): RouteDay[] {
  const acc = new Map<string, { sum: number; n: number; route_id: string; run_date: string }>();
  for (const r of runs) {
    const key = `${r.route_id}|${r.run_date}`;
    const cell = acc.get(key) ?? { sum: 0, n: 0, route_id: r.route_id, run_date: r.run_date };
    cell.sum += Number(r.capacity_frac);
    cell.n += 1;
    acc.set(key, cell);
  }
  const out: RouteDay[] = [];
  for (const cell of acc.values()) out.push({ route_id: cell.route_id, run_date: cell.run_date, cap: cell.sum / cell.n });
  out.sort((a, b) => a.run_date.localeCompare(b.run_date));
  return out;
}

export async function trainAndMaybePromote(createdBy?: string): Promise<TrainSummary> {
  try {
    const { data: routesRaw } = await supabaseAdmin
      .from("truck_capacity_routes")
      .select("id, code, hub, truck_type");
    const routes: RouteMeta[] = (routesRaw ?? []).map((r) => ({
      id: r.id, code: r.code, hub: r.hub, truck_type: r.truck_type,
    }));

    const runs = await fetchAllRuns();
    if (runs.length < 50) {
      return { ok: false, error: `Not enough runs (${runs.length}); need ≥50 to train.` };
    }
    const routeDays = aggregateToRouteDay(runs);

    const minDate = routeDays[0].run_date;
    const maxDate = routeDays[routeDays.length - 1].run_date;
    const cutoffs = buildMonthlyCutoffs(minDate, maxDate, 90);
    if (cutoffs.length < 2) {
      return { ok: false, error: `Not enough history for backtest folds (min=${minDate}, max=${maxDate}).` };
    }

    const result = rollingOriginBacktest({
      routes, routeDays, horizonDays: HORIZON,
      cutoffs, lambdaGrid: LAMBDA_GRID, wGrid: W_GRID,
    });

    const promoted =
      result.overall.n > 0 &&
      result.overall.mae_blend < result.overall.mae_baseline;

    // Demote any previously promoted versions before promoting the new one.
    if (promoted) {
      await supabaseAdmin
        .from("truck_capacity_model_versions")
        .update({ promoted: false })
        .eq("promoted", true);
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("truck_capacity_model_versions")
      .insert({
        coefficients: result.finalCoefficients as any,
        feature_names: result.featureNames as any,
        lambda: result.chosenLambda,
        blend_w: result.chosenW,
        train_rows: routeDays.length,
        horizon_days: HORIZON,
        holdout_mae_baseline: result.overall.mae_baseline,
        holdout_mae_model: result.overall.mae_model,
        holdout_mae_blend: result.overall.mae_blend,
        wape_baseline: result.overall.wape_baseline,
        wape_model: result.overall.wape_model,
        wape_blend: result.overall.wape_blend,
        per_route_mae: result.perRoute as any,
        per_route_residual_mad: result.perRouteResidualMad as any,
        promoted,
        notes: `folds=${result.perFold.length} n=${result.overall.n}`,
        created_by: createdBy ?? null,
      })
      .select("id")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message ?? "insert failed");

    await supabaseAdmin.from("activity_events").insert({
      event_type: promoted ? "truck_capacity.model_promoted" : "truck_capacity.model_trained",
      entity_type: "truck_capacity_model_versions",
      entity_id: inserted.id,
      message: `Truck capacity retrain: λ=${result.chosenLambda}, w=${result.chosenW}, blend MAE ${result.overall.mae_blend.toFixed(4)} vs baseline ${result.overall.mae_baseline.toFixed(4)} (${promoted ? "promoted" : "kept baseline"})`,
      metadata: { chosenLambda: result.chosenLambda, chosenW: result.chosenW, folds: result.perFold.length, n: result.overall.n, promoted },
    });

    return {
      ok: true,
      version_id: inserted.id,
      promoted,
      chosenLambda: result.chosenLambda,
      chosenW: result.chosenW,
      train_rows: routeDays.length,
      holdout_mae_baseline: result.overall.mae_baseline,
      holdout_mae_model: result.overall.mae_model,
      holdout_mae_blend: result.overall.mae_blend,
      wape_baseline: result.overall.wape_baseline,
      wape_model: result.overall.wape_model,
      wape_blend: result.overall.wape_blend,
      per_route_mae: result.perRoute,
      fold_count: result.perFold.length,
    };
  } catch (e: any) {
    const error = e?.message ?? String(e);
    try {
      await supabaseAdmin.from("activity_events").insert({
        event_type: "truck_capacity.retrain_failed",
        entity_type: "truck_capacity_model_versions",
        message: `Truck capacity retrain failed: ${error}`,
      });
    } catch { /* swallow */ }
    return { ok: false, error };
  }
}
