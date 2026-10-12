import { beforeEach, describe, expect, it, vi } from "vitest";
type Row = Record<string, unknown>;
type Chain = {
  middleware: () => Chain;
  inputValidator: () => Chain;
  handler: (fn: unknown) => unknown;
};
type Query = {
  select: () => Query;
  not: () => Query;
  eq: () => Query;
  gte: () => Query;
  lte: () => Query;
  order: () => Query;
  limit: () => Promise<{ data: Row[]; error: null }>;
  range: (from: number, to: number) => Promise<{ data: Row[]; error: null }>;
};
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain: Chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (fn: unknown) => fn,
    };
    return chain;
  },
}));
vi.mock("@/lib/branch-guard", () => ({ denyLegacyBranchAccess: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/p21.server", () => ({
  runJob: () => {
    throw Error("No bridge jobs");
  },
}));
vi.mock("@/lib/sql-schedules.server", () => ({
  validateSelectSql: vi.fn(),
  stripLeadingSqlComments: vi.fn(),
}));
vi.mock("@/lib/truck-capacity.server", () => ({
  computeForecastForRoute: vi.fn(),
  exportCapacityWorkbook: vi.fn(),
  parseImportWorkbook: vi.fn(),
  applyImportRows: vi.fn(),
  runP21Snapshot: vi.fn(),
  DEFAULT_P21_SQL: "",
  DEFAULT_P21_TRANSFER_SQL: "",
  validateP21SqlText: vi.fn(),
  validateP21SqlOutput: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: () => Promise.resolve({ data: true }),
    from(table: string) {
      const query: Query = {
        select: () => query,
        not: () => query,
        eq: () => query,
        gte: () => query,
        lte: () => query,
        order: () => query,
        limit: () => Promise.resolve({ data: state.tables[table] ?? [], error: null }),
        range: (f: number, t: number) =>
          Promise.resolve({ data: (state.tables[table] ?? []).slice(f, t + 1), error: null }),
      };
      return query;
    },
  },
}));
import { buildForecastVsTracker } from "../../truck-capacity.functions";
beforeEach(() => {
  state.tables = {
    truck_capacity_routes: [
      { id: "r", code: "DAL-LOCAL", name: "Dallas", hub: "Dallas", active: true },
    ],
    route_cutoffs: [
      {
        route_id: "r",
        cutoff_dow: 2,
        cutoff_time: "16:00",
        tz: "America/Chicago",
        run_dows: [3],
        active: true,
      },
    ],
    truck_capacity_runs: [
      { route_id: "r", run_date: "2026-09-09", capacity_frac: 0.6 },
      { route_id: "r", run_date: "2026-09-16", capacity_frac: 0.4 },
      { route_id: "r", run_date: "2026-09-16", capacity_frac: 0.8 },
      { route_id: "r", run_date: "2026-09-23", capacity_frac: 0.5, missing_from_sheet: true },
      { route_id: "r", run_date: "2026-09-30", capacity_frac: 0 },
    ],
    truck_capacity_forecast_log: ["2026-09-09", "2026-09-16", "2026-09-23"].map((date) => ({
      route_id: "r",
      forecast_date: date,
      made_on: "2026-09-07",
      served: 0.5,
      predicted: 0.5,
      method: "baseline",
    })),
  };
});
describe("tracker reconciliation integration", () => {
  const input = { from: "2026-09-01", to: "2026-09-30", madeOnFrom: "2026-07-31" };
  it("retains comparable legacy metrics and discloses the complete strict denominator", async () => {
    const result = await buildForecastVsTracker(input, "operator");
    expect(result.overall).toMatchObject({ n: 3, within10N: 3 });
    expect(result.strict.overall).toMatchObject({ n: 1, within10N: 1 });
    expect(result.strict.coverage).toEqual({
      eligible: 1,
      denominator: 4,
      excluded: 3,
      exclusions: { multiple_departures: 1, missing_from_sheet: 1, no_forecast: 1 },
    });
    expect(result.coverage.unscoredNoForecast).toBe(1);
    const multi = result.rows.find((r) => r.run_date === "2026-09-16");
    expect(multi).toMatchObject({ runs: 2, strict_eligible: false });
    expect(multi.actual).toBeCloseTo(0.6);
    expect(multi.total_truck_equivalents).toBeCloseTo(1.2);
  });
  it("shows an empty strict score with four actual route-days when forecasts are absent", async () => {
    state.tables.truck_capacity_forecast_log = [];
    const result = await buildForecastVsTracker(input, "operator");
    expect(result.overall.n).toBe(0);
    expect(result.strict.overall.within10).toBeNull();
    expect(result.strict.coverage).toMatchObject({ eligible: 0, denominator: 4, excluded: 4 });
    expect(result.coverage.unscoredNoForecast).toBe(4);
  });
  it("explicitly discloses that timing eligibility cannot validate legacy actual units or collapsed departures", async () => {
    state.tables.truck_capacity_runs[0].capacity_frac = 0.014;
    const result = await buildForecastVsTracker(input, "operator");
    expect(result.strict.overall.n).toBe(1);
    expect(result.strict.limitation).toContain(
      "legacy actual units and departure completeness remain unverified",
    );
    expect(result.rows[0].actual).toBe(0.014);
  });
});
