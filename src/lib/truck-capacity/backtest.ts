// Rolling-origin backtest for ridge model + blend selection.

import { ridgeSolve, predict as vecPredict, clamp, mean as meanFn, mad as madFn } from "./linalg";
import type { RunPoint } from "./baseline";
import { baselinePoint } from "./baseline";
import {
  buildFeatureContext, buildFeatureRow, buildLagBlock, featureNames,
  type FeatureContext, type RouteMeta,
} from "./features";

export type RouteDay = {
  route_id: string;
  run_date: string;      // ISO
  cap: number;           // mean capacity across runs that day
};

export type BacktestInput = {
  routes: RouteMeta[];
  routeDays: RouteDay[]; // grain: route × day (mean if multi-run)
  horizonDays: number;   // 28
  cutoffs: string[];     // ISO, ascending
  lambdaGrid: number[];  // e.g. [0.3, 1, 3, 10, 30, 100]
  wGrid: number[];       // e.g. [0, 0.3, 0.5, 0.7, 1.0]
};

export type BacktestResult = {
  ctx: FeatureContext;
  featureNames: string[];
  perFold: Array<{ cutoff: string; n: number }>;
  chosenLambda: number;
  chosenW: number;
  overall: {
    mae_baseline: number; mae_model: number; mae_blend: number;
    wape_baseline: number; wape_model: number; wape_blend: number;
    n: number;
  };
  perRoute: Record<string, { baseline: number; model: number; blend: number; n: number }>;
  perRouteResidualMad: Record<string, number>;
  finalCoefficients: number[];
};

// --------------------------------------------------------------------------

function firstOfMonthAdd(iso: string, months: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months, 1);
  return d.toISOString().slice(0, 10);
}

export function buildMonthlyCutoffs(minDate: string, maxDate: string, warmupDays = 90): string[] {
  const start = new Date(minDate + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() + warmupDays);
  const startISO = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 2).padStart(2, "0")}-01`.slice(0, 10);
  const cutoffs: string[] = [];
  let cur = startISO;
  while (cur <= maxDate) {
    cutoffs.push(cur);
    cur = firstOfMonthAdd(cur, 1);
  }
  return cutoffs;
}

function fitAndScore(
  ctx: FeatureContext,
  train: Array<{ x: number[]; y: number }>,
  test: Array<{ x: number[]; y: number; baseline: number; route_id: string }>,
  lambda: number,
): { beta: number[]; predsBase: number[]; predsModel: number[] } {
  const X = train.map((t) => t.x);
  const y = train.map((t) => t.y);
  const beta = ridgeSolve(X, y, lambda, [0]);
  void ctx;
  const predsModel = test.map((t) => clamp(vecPredict(t.x, beta), 0, 1.25));
  const predsBase = test.map((t) => t.baseline);
  return { beta, predsBase, predsModel };
}

function metrics(preds: number[], ys: number[]) {
  if (ys.length === 0) return { mae: 0, wape: 0, n: 0 };
  let ae = 0, sy = 0;
  for (let i = 0; i < ys.length; i++) { ae += Math.abs(preds[i] - ys[i]); sy += Math.abs(ys[i]); }
  return { mae: ae / ys.length, wape: sy > 0 ? ae / sy : 0, n: ys.length };
}

export function rollingOriginBacktest(input: BacktestInput): BacktestResult {
  const { routes, routeDays, horizonDays, cutoffs, lambdaGrid, wGrid } = input;
  const runsByRoute = new Map<string, RunPoint[]>();
  const runsByHub = new Map<string, RunPoint[]>();
  const routeById = new Map(routes.map((r) => [r.id, r]));
  for (const rd of routeDays) {
    const rp: RunPoint = { date: rd.run_date, cap: rd.cap };
    const arr = runsByRoute.get(rd.route_id) ?? [];
    arr.push(rp);
    runsByRoute.set(rd.route_id, arr);
    const meta = routeById.get(rd.route_id);
    if (meta) {
      const harr = runsByHub.get(meta.hub) ?? [];
      harr.push(rp);
      runsByHub.set(meta.hub, harr);
    }
  }
  for (const arr of runsByRoute.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  for (const arr of runsByHub.values()) arr.sort((a, b) => a.date.localeCompare(b.date));

  const ctx = buildFeatureContext(routes, routeDays.map((r) => ({ date: r.run_date })));
  const names = featureNames(ctx);

  // Build fold datasets (train, test) per cutoff.
  const folds: Array<{
    cutoff: string;
    train: Array<{ x: number[]; y: number }>;
    test: Array<{ x: number[]; y: number; baseline: number; route_id: string }>;
  }> = [];

  for (const cutoff of cutoffs) {
    const cutoffEnd = new Date(cutoff + "T00:00:00Z");
    cutoffEnd.setUTCDate(cutoffEnd.getUTCDate() + horizonDays);
    const cutoffEndISO = cutoffEnd.toISOString().slice(0, 10);

    // TRAIN: every historical route-day with run_date < cutoff, using lags "as of run_date"
    const train: Array<{ x: number[]; y: number }> = [];
    for (const rd of routeDays) {
      if (rd.run_date >= cutoff) continue;
      const meta = routeById.get(rd.route_id);
      if (!meta) continue;
      const rr = runsByRoute.get(rd.route_id) ?? [];
      const hr = runsByHub.get(meta.hub) ?? [];
      const lags = buildLagBlock(rr, hr, rd.run_date, rd.run_date);
      const x = buildFeatureRow(ctx, meta, rd.run_date, lags);
      train.push({ x, y: rd.cap });
    }
    if (train.length < 20) continue;

    // TEST: route-days with cutoff <= run_date < cutoff+horizon. Lags frozen at cutoff.
    const test: Array<{ x: number[]; y: number; baseline: number; route_id: string }> = [];
    for (const rd of routeDays) {
      if (rd.run_date < cutoff || rd.run_date >= cutoffEndISO) continue;
      const meta = routeById.get(rd.route_id);
      if (!meta) continue;
      const rr = runsByRoute.get(rd.route_id) ?? [];
      const hr = runsByHub.get(meta.hub) ?? [];
      // Freeze lags at cutoff (no peeking).
      const rrFrozen = rr.filter((r) => r.date < cutoff);
      const hrFrozen = hr.filter((r) => r.date < cutoff);
      const lags = buildLagBlock(rrFrozen, hrFrozen, cutoff, rd.run_date);
      const x = buildFeatureRow(ctx, meta, rd.run_date, lags);
      const baseline = baselinePoint(rrFrozen, hrFrozen.map((r) => r.cap), rd.run_date);
      test.push({ x, y: rd.cap, baseline, route_id: rd.route_id });
    }
    if (test.length === 0) continue;
    folds.push({ cutoff, train, test });
  }

  if (folds.length === 0) {
    return {
      ctx, featureNames: names,
      perFold: [], chosenLambda: 1, chosenW: 0,
      overall: { mae_baseline: 0, mae_model: 0, mae_blend: 0, wape_baseline: 0, wape_model: 0, wape_blend: 0, n: 0 },
      perRoute: {}, perRouteResidualMad: {}, finalCoefficients: [],
    };
  }

  // Split folds in half chronologically. Select on first half; holdout second.
  const half = Math.floor(folds.length / 2);
  const selectFolds = folds.slice(0, Math.max(1, half));
  const holdoutFolds = folds.slice(Math.max(1, half));

  // Grid search over λ × w on select folds → pick min blend MAE.
  let best = { lambda: lambdaGrid[0], w: wGrid[0], mae: Infinity };
  for (const lambda of lambdaGrid) {
    // For each select fold, fit + score.
    const perFoldPreds: Array<{ base: number[]; model: number[]; y: number[] }> = [];
    for (const f of selectFolds) {
      const { predsBase, predsModel } = fitAndScore(ctx, f.train, f.test, lambda);
      perFoldPreds.push({ base: predsBase, model: predsModel, y: f.test.map((t) => t.y) });
    }
    for (const w of wGrid) {
      let ae = 0, n = 0;
      for (const p of perFoldPreds) {
        for (let i = 0; i < p.y.length; i++) {
          const blend = clamp(w * p.model[i] + (1 - w) * p.base[i], 0, 1.25);
          ae += Math.abs(blend - p.y[i]);
          n++;
        }
      }
      const mae = n > 0 ? ae / n : Infinity;
      if (mae < best.mae) best = { lambda, w, mae };
    }
  }

  // Score holdout using chosen (λ, w).
  const perRouteAgg: Record<string, { ae_b: number; ae_m: number; ae_l: number; sy: number; n: number; resid: number[] }> = {};
  const overallY: number[] = [];
  const overallB: number[] = [];
  const overallM: number[] = [];
  const overallL: number[] = [];
  for (const f of holdoutFolds) {
    const { predsBase, predsModel } = fitAndScore(ctx, f.train, f.test, best.lambda);
    for (let i = 0; i < f.test.length; i++) {
      const t = f.test[i];
      const b = predsBase[i], m = predsModel[i];
      const blend = clamp(best.w * m + (1 - best.w) * b, 0, 1.25);
      overallY.push(t.y); overallB.push(b); overallM.push(m); overallL.push(blend);
      const agg = perRouteAgg[t.route_id] ?? { ae_b: 0, ae_m: 0, ae_l: 0, sy: 0, n: 0, resid: [] };
      agg.ae_b += Math.abs(b - t.y);
      agg.ae_m += Math.abs(m - t.y);
      agg.ae_l += Math.abs(blend - t.y);
      agg.sy += Math.abs(t.y);
      agg.n += 1;
      agg.resid.push(blend - t.y);
      perRouteAgg[t.route_id] = agg;
    }
  }

  const overall = {
    ...metrics(overallB, overallY), mae_baseline: metrics(overallB, overallY).mae,
    mae_model: metrics(overallM, overallY).mae,
    mae_blend: metrics(overallL, overallY).mae,
    wape_baseline: metrics(overallB, overallY).wape,
    wape_model: metrics(overallM, overallY).wape,
    wape_blend: metrics(overallL, overallY).wape,
    n: overallY.length,
  };

  const perRoute: BacktestResult["perRoute"] = {};
  const perRouteResidualMad: Record<string, number> = {};
  for (const [rid, a] of Object.entries(perRouteAgg)) {
    perRoute[rid] = {
      baseline: a.n > 0 ? a.ae_b / a.n : 0,
      model: a.n > 0 ? a.ae_m / a.n : 0,
      blend: a.n > 0 ? a.ae_l / a.n : 0,
      n: a.n,
    };
    perRouteResidualMad[rid] = madFn(a.resid);
  }

  // Fit final model on ALL route-days with lags "as of run_date".
  const finalX: number[][] = [];
  const finalY: number[] = [];
  for (const rd of routeDays) {
    const meta = routeById.get(rd.route_id);
    if (!meta) continue;
    const rr = runsByRoute.get(rd.route_id) ?? [];
    const hr = runsByHub.get(meta.hub) ?? [];
    const rrPast = rr.filter((r) => r.date < rd.run_date);
    const hrPast = hr.filter((r) => r.date < rd.run_date);
    const lags = buildLagBlock(rrPast, hrPast, rd.run_date, rd.run_date);
    finalX.push(buildFeatureRow(ctx, meta, rd.run_date, lags));
    finalY.push(rd.cap);
  }
  const finalBeta = finalX.length > 0 ? ridgeSolve(finalX, finalY, best.lambda, [0]) : [];
  void meanFn;

  return {
    ctx, featureNames: names,
    perFold: folds.map((f) => ({ cutoff: f.cutoff, n: f.test.length })),
    chosenLambda: best.lambda, chosenW: best.w,
    overall, perRoute, perRouteResidualMad,
    finalCoefficients: finalBeta,
  };
}
