import { beforeEach, describe, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, calls: [] as any[], fail: null as string | null, writes: 0 }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = []; let limit = Infinity; let select = "";
      const rows = () => { state.calls.push({ table, select }); const data = (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit); return { data, error: state.fail === table ? { message: "synthetic error" } : null }; };
      const field = (r: any, k: string) => (k.includes("->>") ? r[k.split("->>")[0]!]?.[k.split("->>")[1]!] : r[k]);
      const deny = () => { state.writes++; throw Error("No writes allowed"); };
      const q: any = {
        select: (s: string) => { select = s; return q; },
        eq: (k: string, v: any) => { filters.push((r) => field(r, k) === v); return q; },
        in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(field(r, k))); return q; },
        gte: (k: string, v: any) => { filters.push((r) => field(r, k) >= v); return q; },
        lte: (k: string, v: any) => { filters.push((r) => field(r, k) <= v); return q; },
        not: () => q, order: () => q, limit: (n: number) => { limit = n; return q; },
        maybeSingle: async () => { const r = rows(); return { ...r, data: r.data[0] ?? null }; },
        then: (res: any, rej: any) => Promise.resolve(rows()).then(res, rej),
        insert: deny, update: deny, upsert: deny, delete: deny,
      };
      return q;
    },
    rpc: () => { state.writes++; throw Error("No RPC allowed"); },
  },
}));
import { readBranchLogistics, checkLegacyAccess } from "../branch-logistics.server";

beforeEach(() => {
  state.calls = []; state.fail = null; state.writes = 0;
  state.tables = {
    user_roles: [{ user_id: "manager", role: "branch_manager" }],
    branch_manager_warehouses: [{ user_id: "manager", warehouse: "Birmingham", active: true }],
    truck_capacity_routes: [{ id: "00000000-0000-4000-8000-00000000000b", code: "B", hub: "Birmingham" }, { id: "00000000-0000-4000-8000-00000000000d", code: "D", hub: "Dallas" }],
    truck_capacity_runs: [{ id: "b-run", route_id: "00000000-0000-4000-8000-00000000000b", run_date: "2026-09-28", capacity_frac: 0.6 }, { id: "d-run", route_id: "00000000-0000-4000-8000-00000000000d", run_date: "2026-09-28", capacity_frac: 0.99 }],
    dispatch_runs: [{ id: "b-dispatch", route_id: "00000000-0000-4000-8000-00000000000b" }, { id: "d-dispatch", route_id: "00000000-0000-4000-8000-00000000000d" }],
    dispatch_stops: [{ id: "b-stop", dispatch_run_id: "b-dispatch" }, { id: "d-stop", dispatch_run_id: "d-dispatch" }],
  };
});
const W = "2026-09-28";

describe("branch server adapter (synthetic tables, no writes)", () => {
  it("driver time: only local events and local official totals, no private fields", async () => {
    state.tables.driver_warehouse_events = [
      { id: "e-b", driver_id: "synthetic", driver_name: "Synthetic Driver", hub: "Birmingham", event_date: W, start_ts: "2026-09-28T13:00:00Z", end_ts: "2026-09-28T16:00:00Z", duration_min: 180, location_source: "log", status: "reviewed" },
      { id: "e-d", driver_id: "synthetic", driver_name: "Synthetic Driver", hub: "Dallas", event_date: W, start_ts: "2026-09-28T16:00:00Z", end_ts: "2026-09-28T23:00:00Z", duration_min: 420, location_source: "log", status: "reviewed" },
    ];
    state.tables.driver_time_week_overrides = [
      { driver_id: "synthetic", week_start: W, warehouse_actual: { driverName: "Synthetic Driver", hub: "Birmingham", minutes: 120, scope: "weekdays", source: "PRIVATE SOURCE", reason: "PRIVATE REASON" } },
      { driver_id: "foreign", week_start: W, warehouse_actual: { driverName: "Foreign Driver", hub: "Dallas", minutes: 999, scope: "weekdays", source: "PRIVATE SOURCE", reason: "PRIVATE REASON" } },
    ];
    const r: any = await readBranchLogistics("manager", { module: "driver-time", weekStart: W });
    expect(r.drivers).toHaveLength(1);
    expect(r.drivers[0].events.map((e: any) => e.id)).toEqual(["e-b"]);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE|Foreign Driver/);
    expect(state.writes).toBe(0);
  });
  it("legacy gate blocks managers, fails closed, permits operators", async () => {
    await expect(checkLegacyAccess("manager")).rejects.toThrow(/warehouse-scoped/);
    state.fail = "user_roles"; await expect(checkLegacyAccess("manager")).rejects.toThrow();
    state.fail = null; state.tables.user_roles = [{ user_id: "operator", role: "ops_logistics" }];
    await expect(checkLegacyAccess("operator")).resolves.toBeUndefined();
  });
  it("capacity filtered to the warehouse", async () => {
    const r: any = await readBranchLogistics("manager", { module: "truck-capacity", weekStart: W });
    expect(r.routes.map((x: any) => x.code)).toEqual(["B"]);
    expect(r.runs.map((x: any) => x.id)).toEqual(["b-run"]);
  });
  it("fails closed on role or mapping lookup errors before any business read", async () => {
    for (const t of ["user_roles", "branch_manager_warehouses"]) {
      state.fail = t;
      await expect(readBranchLogistics("manager", { module: "truck-capacity", weekStart: W })).rejects.toThrow();
    }
    expect(state.calls.some((c) => c.table === "truck_capacity_runs")).toBe(false);
  });
  it("foreign route rejected before forecasting or fetching runs", async () => {
    await expect(readBranchLogistics("manager", { module: "truck-capacity", weekStart: W, routeId: "00000000-0000-4000-8000-00000000000d" })).rejects.toThrow(/access denied/);
    expect(state.calls.some((c) => c.table === "truck_capacity_runs")).toBe(false);
  });
  it("foreign run rejected before fetching stops", async () => {
    await expect(readBranchLogistics("manager", { module: "dispatch", weekStart: W, runId: "d-dispatch" })).rejects.toThrow(/access denied/);
    expect(state.calls.some((c) => c.table === "dispatch_stops")).toBe(false);
  });
  it("inactive, unassigned and mixed-role users are rejected", async () => {
    state.tables.branch_manager_warehouses = [{ user_id: "manager", warehouse: "Birmingham", active: false }];
    await expect(readBranchLogistics("manager", { module: "truck-capacity", weekStart: W })).rejects.toThrow();
    state.tables.branch_manager_warehouses = [];
    await expect(readBranchLogistics("manager", { module: "truck-capacity", weekStart: W })).rejects.toThrow();
    state.tables.branch_manager_warehouses = [{ user_id: "manager", warehouse: "Birmingham", active: true }];
    state.tables.user_roles.push({ user_id: "manager", role: "admin" });
    await expect(readBranchLogistics("manager", { module: "truck-capacity", weekStart: W })).rejects.toThrow(/Mixed/);
  });
  it("empty warehouse route set produces no business reads", async () => {
    state.tables.truck_capacity_routes = [];
    const r: any = await readBranchLogistics("manager", { module: "dispatch", weekStart: W });
    expect(r.runs).toEqual([]); expect(r.tickets).toEqual([]);
    expect(state.calls.some((c) => ["dispatch_runs", "p21_bridge_jobs", "dispatch_stops"].includes(c.table))).toBe(false);
  });
});
