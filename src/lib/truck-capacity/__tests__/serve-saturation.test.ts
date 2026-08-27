// Regression tests for the sparse-route forecast collapse.
//
// 1a: a ridge prediction that hits the clamp floor (raw <= 0) must not be
//     blended at 50% against a healthy baseline (BHM-SPECIAL 2026-07-21).
// 1c: zero active weekdays + empty typical_dow must not silently serve a number.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildFeatureContext, featureNames, type RouteMeta } from "../features";

type Row = Record<string, any>;

const ROUTE: Row = {
  id: "R1",
  code: "BHM-SPECIAL",
  hub: "Birmingham",
  truck_type: null,
  typical_dow: [],
};

// Two Tuesdays at 0.636 inside the 56-day window as of 2026-07-13 →
// activeDows = {2}, byDow(2) = [0.636, 0.636], month factor = 1.
const TUESDAY_RUNS: Row[] = [
  { run_date: "2026-06-30", capacity_frac: 0.636 },
  { run_date: "2026-07-07", capacity_frac: 0.636 },
];

function persistedNamesFor(route: RouteMeta, minRunDate: string) {
  const ctx = buildFeatureContext([route], [{ date: minRunDate }]);
  return featureNames(ctx);
}

/** Minimal chainable stand-in for the supabase-js query builder. */
function makeAdmin(opts: { routeRuns: Row[]; version: Row | null; route: Row }) {
  const calls: Row[] = [];
  const build = (table: string) => {
    const state: { select: string; eq: Record<string, any> } = { select: "", eq: {} };
    const rows = (): Row[] => {
      switch (table) {
        case "truck_capacity_routes":
          return [opts.route];
        case "truck_capacity_runs": {
          if ("route_id" in state.eq || "truck_capacity_routes.hub" in state.eq) {
            return opts.routeRuns;
          }
          return [...opts.routeRuns].sort((a, b) => a.run_date.localeCompare(b.run_date));
        }
        case "truck_capacity_p21_demand":
          return [];
        case "truck_capacity_model_versions":
          return opts.version ? [opts.version] : [];
        default:
          return [];
      }
    };
    const builder: any = {
      select: (s = "") => { state.select = s; return builder; },
      eq: (k: string, v: any) => { state.eq[k] = v; return builder; },
      gte: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      insert: (payload: any) => { calls.push({ table, op: "insert", payload }); return Promise.resolve({ error: null }); },
      upsert: (payload: any) => { calls.push({ table, op: "upsert", payload }); return Promise.resolve({ error: null }); },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
    };
    return builder;
  };
  return { admin: { from: (t: string) => build(t) }, calls };
}

const admins: { current: ReturnType<typeof makeAdmin>["admin"] | null } = { current: null };

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return admins.current as any;
  },
}));

describe("serving: model saturation must not poison the blend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T15:00:00Z")); // Chicago 10:00, 2026-07-13
  });
  afterEach(() => {
    vi.useRealTimers();
    admins.current = null;
  });

  it("1a: clamp-floor model output is not averaged against a healthy baseline", async () => {
    const routeMeta: RouteMeta = { id: ROUTE.id, code: ROUTE.code, hub: ROUTE.hub, truck_type: null };
    const names = persistedNamesFor(routeMeta, TUESDAY_RUNS[0].run_date);
    const coefficients = names.map((n) => (n === "intercept" ? -5 : 0)); // raw prediction = -5

    const { admin } = makeAdmin({
      route: ROUTE,
      routeRuns: TUESDAY_RUNS,
      version: {
        id: "V1",
        trained_at: "2026-07-10T00:00:00Z",
        coefficients,
        feature_names: names,
        lambda: 1,
        blend_w: 0.5,
        holdout_mae_baseline: 0.19,
        holdout_mae_model: 0.2,
        holdout_mae_blend: 0.18,
        per_route_residual_mad: {},
        promoted: true,
      },
    });
    admins.current = admin;

    const { computeForecastForRoute } = await import("../serve");
    const res = await computeForecastForRoute(ROUTE.id, 14, "auto");
    const day = res.days.find((d) => d.date === "2026-07-21");
    expect(day, "2026-07-21 must be inside the horizon").toBeTruthy();

    // Baseline is healthy.
    expect(day!.baseline).toBeCloseTo(0.636, 3);
    expect(day!.forecast).toBeCloseTo(0.636, 3);

    // The bug: 0.5*0 + 0.5*0.636 = 0.318 served.
    expect(day!.final).not.toBeCloseTo(0.318, 3);
    expect(day!.final).toBeCloseTo(0.636, 3);
    expect((day as any).model_saturated).toBe(true);
    expect(day!.explain).toMatch(/saturat/i);
  });

  it("1c: no baseline and no active weekday must not serve a silent unflagged number", async () => {
    const sparseRoute = { ...ROUTE, code: "SEFL", typical_dow: [] };
    const routeMeta: RouteMeta = { id: sparseRoute.id, code: "SEFL", hub: "Ocala", truck_type: null };
    const sparseRuns: Row[] = [{ run_date: "2026-07-06", capacity_frac: 0.42 }]; // single Monday run
    const names = persistedNamesFor(routeMeta, sparseRuns[0].run_date);
    const coefficients = names.map((n) => (n === "intercept" ? -5 : 0));

    const { admin } = makeAdmin({
      route: { ...sparseRoute, hub: "Ocala" },
      routeRuns: sparseRuns,
      version: {
        id: "V1",
        trained_at: "2026-07-10T00:00:00Z",
        coefficients,
        feature_names: names,
        lambda: 1,
        blend_w: 0.5,
        holdout_mae_baseline: 0.19,
        holdout_mae_model: 0.2,
        holdout_mae_blend: 0.18,
        per_route_residual_mad: {},
        promoted: true,
      },
    });
    admins.current = admin;

    const { computeForecastForRoute } = await import("../serve");
    const res = await computeForecastForRoute(sparseRoute.id, 14, "auto");
    for (const day of res.days) {
      expect(day.baseline).toBeNull();
      if (day.final != null) {
        // A number was served with no baseline: it must be flagged, not silent.
        expect((day as any).low_confidence).toBe(true);
        expect(day.explain).toMatch(/no baseline|low confidence|saturat/i);
      }
    }
  });
});
