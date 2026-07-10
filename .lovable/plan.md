
# Truck Capacity — Learning Forecast (v2)

Upgrade the current trimmed-mean × seasonal baseline into a continuously-learning ridge model. Baseline stays intact as both a fallback and a blend component. Serving is gated by a rolling-origin backtest so a bad retrain cannot degrade production forecasts.

## 1. Reuse vs. new

**Reuse (no changes to shape):**
- `computeForecastForRoute` in `truck-capacity.server.ts` → keep, but rename its export to `computeBaselineForecastForRoute` and call it from a new `computeForecastForRoute` wrapper that also runs the model + blend + promotion gate. Callers (`getTruckForecast` server fn, Forecast UI) unchanged.
- `runP21Snapshot`, `parseImportWorkbook`, `applyImportRows`, `exportCapacityWorkbook` — untouched.
- `run-sql-schedules.ts` cron caller — add a nightly retrain step after the existing 07:00–07:15 UTC P21 snapshot window, dedup-guarded the same way (skip if a `truck_capacity_model_versions` row exists with `trained_at >= todayUTC`).
- `validateSelectSql`, `runJob`, `assertAdmin`, `requireOpsOrAdmin` — reused as-is.
- `activity_events` — log every retrain / promotion / snapshot skip (same pattern as `truck_capacity.snapshot_failed`).

**New:**
- Pure-TS linear algebra helper (Cholesky + ridge closed-form). Small enough to live in-repo; no npm dependency.
- Feature builder over `truck_capacity_runs` snapshots ("as-of" a cutoff date — critical for backtest correctness).
- Backtest harness (rolling monthly cutoffs, 28d horizon), λ/w grid search, promotion gate.
- Model registry table + optional forecast log table.
- Retrain hook: (a) nightly cron, (b) post-import commit, (c) manual admin button.

**Conflicts / notes:**
- The current baseline computes a single `monthFactor` map from a 84-day trailing window and indexes by target month. Backtest must respect that; when replaying historical cutoffs, we must recompute baseline "as of cutoff" (only runs with `run_date < cutoff`) — the existing function reads the live DB, so we need an in-memory variant that accepts a `runs[]` snapshot + `asOf` date. Plan: extract the pure computation into `_baselineFromSnapshot(runs, hubRuns, asOf, horizonDays)`; the DB-reading function becomes a thin wrapper. Backtest and retrain use the pure variant.
- `truck_capacity_p21_demand` is snapshot-only and (by design) sparse before today. Backtest folds cannot use the P21 max-guard because historical snapshots weren't taken; the guard remains a serving-time step and is excluded from MAE calculations.
- No changes to `run-sql-schedules.ts` signature; retrain is one more optional step alongside the snapshot.

## 2. Migrations

Single migration `add-truck-capacity-model-registry`:

```
truck_capacity_model_versions (id, trained_at, coefficients jsonb, feature_names jsonb[],
  lambda numeric, blend_w numeric, train_rows int, horizon_days int default 28,
  holdout_mae_baseline numeric, holdout_mae_model numeric, holdout_mae_blend numeric,
  wape_baseline numeric, wape_model numeric, wape_blend numeric,
  per_route_mae jsonb,        -- { route_id: { baseline, model, blend, n } }
  per_route_residual_mad jsonb, -- { route_id: number } — used for per-route uncertainty band
  promoted boolean default false, notes text, created_by uuid)

truck_capacity_forecast_log (id, route_id fk, forecast_date date, made_on date,
  predicted numeric, method text,       -- 'baseline' | 'model' | 'blend'
  model_version_id uuid nullable, created_at)
  unique(route_id, forecast_date, made_on, method)
```

Both tables:
- Standard GRANTs (`authenticated` read; `service_role` all).
- RLS ON; authenticated SELECT; INSERT/UPDATE restricted to admin (versions) or service-role only (log).
- `updated_at` trigger not needed on either.

No changes to existing tables.

## 3. File plan

```
src/lib/truck-capacity/
  linalg.ts                    Cholesky ridge solve, matrix ops (pure, unit-testable)
  features.ts                  buildFeatureRow(route, cutoff, runsByRoute, hubRunsByHub) → number[]
                               featureNames() → string[]  (stable order, versioned)
  baseline.ts                  extracted _baselineFromSnapshot(runs, hubMean, asOf, horizonDays)
                               (re-exported by truck-capacity.server.ts)
  backtest.ts                  rollingOriginBacktest(runs, cutoffs[], λGrid, wGrid) →
                               { chosen: {λ, w}, perFold, perRoute, overall }
  train.ts                     trainAndMaybePromote() → writes truck_capacity_model_versions row,
                               flips `promoted` if holdout MAE(blend) < MAE(baseline).
                               Serving reads the latest promoted row.
  serve.ts                     computeForecastForRoute(routeId, horizon, methodOverride?)
                               loads promoted version, computes features live, blends, applies
                               P21 max guard, returns ForecastDay[] with driver breakdown.
  explain.ts                   groupContributions(coeffs, x, featureNames) → { group: contribution }
                               → plain-language summary strings.
src/lib/truck-capacity.server.ts   thin: re-exports serve.ts + baseline.ts + P21 + import/export
                                    (existing file shrinks; behavior unchanged for callers).
src/lib/truck-capacity.functions.ts  add:
  retrainTruckModel()          admin-only; wraps train.trainAndMaybePromote(); returns summary.
  listTruckModelVersions()     admin; last 20 rows.
  getTruckAccuracy()           latest promoted version's per-route table + overall MAE/WAPE.
  getTruckForecast()           existing endpoint — now accepts optional `method: 'auto'|'baseline'|'model'`.
src/routes/_app.truck-capacity.tsx  Forecast tab: method toggle + serving badge + explain rewrite.
                                    New Accuracy sub-panel (per-route MAE/WAPE table + version sparkline;
                                    forecast-log overlay once data accumulates).
                                    Settings: "Retrain now" button (admin).
src/routes/api/public/run-sql-schedules.ts  add nightly-retrain step (dedup by trained_at ≥ todayUTC).
```

## 4. Feature vector (~63 dims, stable order stored in `feature_names`)

Order committed to the model version row so serving reproduces exactly:

1. intercept (1)
2. weekday dummies Mon–Sat (6; Sun = reference)
3. month dummies Feb–Dec (11; Jan = reference)
4. hub dummies (Birmingham, Ocala; Dallas = reference)
5. truck_type == 'box_truck' flag
6. linear trend = days_since_first_run / 365
7. Lag block (computed from `runs` where `run_date < asOf`):
   - route EW-mean, halflife=5 runs
   - route last run capacity_frac
   - route same-weekday trimmed mean (56d, n ≥ 2)
   - route overall mean (56d)
   - route run_count / 30, capped at 1.0
   - missing_history flag (1 if route has < 2 runs)
   - hub trailing 28d mean
8. route identity dummies (N-1 routes, one held out)

Missing lags → 0 with the missing-history flag set, so ridge learns the intercept + hub-mean fallback rather than crashing on cold-start routes.

## 5. Fit and backtest

`linalg.ts`:
- `ridgeSolve(X, y, λ, penalizeIntercept=false)` — builds `A = XᵀX + λP`, `b = Xᵀy`, solves by Cholesky. Pure loops; no BLAS.
- Deterministic ordering of feature columns.

`backtest.ts`:
- Cutoffs = first of each month from `min(run_date)+90d` through current month.
- For each cutoff: build training set of route-days with `run_date < cutoff`, targets are actuals in `[cutoff, cutoff+28d]`. Features frozen at cutoff.
- λ ∈ {0.3, 1, 3, 10, 30, 100}; w ∈ {0, 0.3, 0.5, 0.7, 1.0}.
- Split folds by chronology: earlier half → select (λ, w) by mean fold MAE; later half → holdout.
- Metrics: MAE (baseline, model, blend), WAPE, per-route MAE, per-route residual MAD.

`train.ts`:
1. Pull all runs (paginated, no 1000-row cap). Group by route.
2. Run backtest → chosen (λ, w), holdout metrics.
3. Fit final model on ALL data with chosen λ (coefficients used for serving).
4. Insert `truck_capacity_model_versions` row with `promoted = holdout_mae_blend < holdout_mae_baseline`.
5. Log `truck_capacity.model_trained` / `.model_promoted` activity events.

## 6. Serving

`serve.ts` `computeForecastForRoute(routeId, horizon, methodOverride)`:
1. Pull latest `promoted=true` version (or override='model' uses the latest regardless of promotion).
2. Compute baseline via `computeBaselineForecastForRoute` (unchanged math, existing explain string).
3. If no promoted version OR `method='baseline'`: return baseline as-is.
4. Else for each horizon day:
   - Build feature row live (route + hub state as of today).
   - `modelPred = clamp(β · x, 0, 1.25)`.
   - `blend = clamp(w · modelPred + (1 − w) · baselinePred, 0, 1.25)`.
   - `final = max(blend, p21)` when P21 row exists.
   - Uncertainty band: prefer `per_route_residual_mad[routeId]`; fall back to current trailing-window MAD.
   - Driver breakdown via `explain.groupContributions`.
5. Log served forecast into `truck_capacity_forecast_log` for future accuracy-vs-actuals evaluation (best-effort insert; ignore unique-conflict duplicates for same made_on/forecast_date/method).

`ForecastDay` shape gains: `model: number|null`, `blend: number|null`, `method: 'baseline'|'model'|'blend'`, `drivers: { group: string; contribution: number }[]`, `driverSummary: string`.

## 7. Retrain hooks

- **Cron:** in `run-sql-schedules.ts`, after the P21 snapshot block, if `now.getUTCHours() === 7 && minutes < 15` AND no `truck_capacity_model_versions` row with `trained_at >= todayStart`, call `trainAndMaybePromote()`. Wrap in try/catch; on error, insert `activity_events` with `truck_capacity.retrain_failed`. Result included in the JSON response body.
- **Post-import:** `commitTruckImport` handler awaits `applyImportRows`, then fires `trainAndMaybePromote()` in a `try/catch` (best-effort; import success is not gated on retrain). Return includes `retrain: { ok, promoted, version_id }` for UI toast.
- **Manual:** `retrainTruckModel` server fn (admin-only, `assertAdmin`) drives a Settings-tab "Retrain now" button. Returns training summary; UI shows toast with holdout numbers and whether it promoted.

## 8. Explainability

`explain.groupContributions(coeffs, x, featureNames)` groups features into readable buckets:
- lane identity (route dummies)
- weekday
- month/season
- trend
- recent form (EW mean, last run, same-weekday lag, overall mean)
- hub
- truck type

For each group, sum `β_i · x_i`; sort by absolute magnitude; render top ±3 into a plain-language string:
> "Higher than usual: Friday +0.06, July +0.03, rising recent form +0.09; P21 open orders below forecast (guard inactive)."

Baseline forecast keeps its own existing explain string ("Thu baseline 0.72 (n=7) × Jul 0.94 = 0.68"); model/blend forecasts append the driver summary. Hover panel shows both when the served method is `blend`.

Update `FORECAST_METHOD_DESCRIPTION` copy to describe baseline, model, blend, promotion gate, and the latest promoted holdout numbers pulled from the DB (rendered by the collapsible in the Forecast tab).

## 9. UI

**Forecast tab:**
- Method toggle: Auto (default; uses promoted method) / Baseline / Model. Sticky per user via localStorage.
- Serving badge next to the chart: `Model v12 promoted — beat baseline 0.183 vs 0.197 MAE (Jul 2026)` or `Baseline serving — model has not beaten baseline yet`.
- Chart: existing lines (Statistical, MAD band, P21) + new dashed "Model" line when applicable + solid "Serving" line = whatever method won. Legend explains.
- Per-day table gains `Model`, `Blend`, `Method`, `Drivers` columns; Drivers cell expands to the plain-language string.

**Accuracy sub-section (Forecast tab):**
- Overall MAE/WAPE for baseline / model / blend from latest promoted version.
- Per-lane table: MAE baseline vs model vs blend, delta %, n. Sortable.
- Version history sparkline (last 20 versions, holdout MAE over time).
- Forecast-vs-actual chart: joins `truck_capacity_forecast_log` (predicted, made_on, method) to `truck_capacity_runs` (actual, run_date=forecast_date, mean over runs that day). Empty state until enough log data accumulates.

**Settings tab:**
- Admin-only "Retrain now" button with confirm dialog; result toast surfaces holdout MAE + promoted flag.
- Read-only summary card: latest promoted version, chosen λ / w, train rows, trained_at.

## 10. Data seeding

Client will attach the historical workbook with build go-ahead. The existing `parseImportWorkbook` + `applyImportRows` path handles it; expose a one-shot admin action (reuse the Import tab flow — no new server fn) so the operator uploads it and the retrain hook triggers automatically on commit. No dev-only seed script; keeps a single code path.

## 11. Out of scope for v2

- Non-linear / tree models.
- Automatic hyperparameter grid expansion.
- Per-day rather than route-day grain.
- Model drift alerting (basic activity_events row is enough for now).
- Serving-side A/B (single promoted version at a time).

## 12. Verification before shipping

- Unit tests (bunx vitest run) for `linalg.ridgeSolve` (compare against a hand-computed 3×2 case), `features.buildFeatureRow` (fixed inputs → known vector), `baseline._baselineFromSnapshot` (regression fixture from current live behavior), `backtest.rollingOriginBacktest` (synthetic 300-row set — asserts blend MAE ≤ baseline MAE within tolerance).
- Manual: run "Retrain now" against seeded data, confirm promotion decision matches offline backtest (λ=1, w=0.7, MAE ~0.183 vs 0.197).
- Typecheck + `vite build` clean.

