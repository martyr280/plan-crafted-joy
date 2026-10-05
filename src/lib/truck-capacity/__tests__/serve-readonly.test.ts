// Branch (warehouse-manager) forecast reads must be pure: with { logForecast: false } a
// promoted model whose live feature coverage is low must write NEITHER the
// feature_coverage_low activity event NOR the forecast_log upsert.
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
      select: (s = "") => {
        state.select = s;
        return builder;
      },
      eq: (k: string, v: any) => {
        state.eq[k] = v;
        return builder;
      },
      gte: () => builder,
      // serve.ts filters no-run markers with .not("capacity_frac","is",null)
      not: () => builder,
      lte: () => builder,
      order: () => builder,
      limit: () => builder,
      insert: (payload: any) => {
        calls.push({ table, op: "insert", payload });
        return Promise.resolve({ error: null });
      },
      upsert: (payload: any) => {
        calls.push({ table, op: "upsert", payload });
        return Promise.resolve({ error: null });
      },
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

function lowCoverageVersion() {
  const routeMeta: RouteMeta = { id: ROUTE.id, code: ROUTE.code, hub: ROUTE.hub, truck_type: null };
  const names = persistedNamesFor(routeMeta, TUESDAY_RUNS[0]!.run_date);
  // Pad with names the live feature set cannot produce -> coverage well below 95%.
  const bogus = Array.from({ length: names.length * 2 }, (_, i) => `retired_feature_${i}`);
  const all = [...names, ...bogus];
  return {
    id: "V-LOW",
    trained_at: "2026-07-10T00:00:00Z",
    coefficients: all.map(() => 0),
    feature_names: all,
    lambda: 1,
    blend_w: 0.5,
    holdout_mae_baseline: 0.19,
    holdout_mae_model: 0.2,
    holdout_mae_blend: 0.18,
    per_route_residual_mad: {},
    promoted: true,
  };
}

describe("forecast serving: read-only option", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T15:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    admins.current = null;
  });

  it("control: default auto serving logs the low-coverage fallback and the forecast", async () => {
    const { admin, calls } = makeAdmin({
      route: ROUTE,
      routeRuns: TUESDAY_RUNS,
      version: lowCoverageVersion(),
    });
    admins.current = admin;
    const { computeForecastForRoute } = await import("../serve");
    const res = await computeForecastForRoute(ROUTE.id, 14, "auto");
    expect(res.servingMethod).toBe("baseline");
    expect(calls.some((c) => c.table === "activity_events" && c.op === "insert")).toBe(true);
    expect(calls.some((c) => c.table === "truck_capacity_forecast_log" && c.op === "upsert")).toBe(
      true,
    );
  });

  it("logForecast:false writes nothing for a promoted low-coverage model", async () => {
    const { admin, calls } = makeAdmin({
      route: ROUTE,
      routeRuns: TUESDAY_RUNS,
      version: lowCoverageVersion(),
    });
    admins.current = admin;
    const { computeForecastForRoute } = await import("../serve");
    const res = await computeForecastForRoute(ROUTE.id, 14, "auto", { logForecast: false });
    expect(res.servingMethod).toBe("baseline");
    expect(res.days.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});
