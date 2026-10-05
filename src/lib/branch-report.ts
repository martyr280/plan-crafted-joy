// Pure orchestration of the read-only warehouse report. All I/O goes through BranchReadPort.
import {
  assertRoute,
  branchDriverDto,
  codesForRoutes,
  scopedDriverInputs,
  scopedRoutes,
  scopedRouteRows,
  scopedTicketRows,
} from "./warehouse-scope";
import type {
  BranchScope,
  DriverEventRow,
  OverrideRow,
  ReconciledDriver,
  RouteRow,
} from "./warehouse-scope";
import type { DispatchBoard } from "./dispatch/board";
import type { P21DispatchRow } from "./dispatch/build";

export type CapacityRunRow = {
  id: string;
  route_id: string | null;
  run_date: string;
  run_seq?: number | null;
  capacity_frac: number | null;
  pallet_count?: number | null;
  returned_pallets?: number | null;
  source?: string | null;
};
export type ForecastDto = {
  days: Array<{
    date: string;
    predicted: number | null;
    current: number | null;
    capacity: number | null;
    lowConfidence: boolean;
    explanation: string | null;
  }>;
};
export type DispatchRunRow = {
  id: string;
  route_id: string | null;
  route_code?: string | null;
  run_date?: string | null;
  status?: string | null;
  stops_total?: number | null;
  stops_held?: number | null;
  est_pallets?: number | null;
  est_cube_ft?: number | null;
  est_weight_lbs?: number | null;
  last_reconciled_at?: string | null;
};
export type DispatchStopRow = {
  id: string;
  dispatch_run_id: string;
  position?: number | null;
  pick_ticket_no?: string | null;
  order_no?: string | null;
  customer_name?: string | null;
  hold?: boolean | null;
  hold_reason?: string | null;
  state?: string | null;
  est_pallets?: number | null;
  est_cube_ft?: number | null;
  est_weight_lbs?: number | null;
};
export type TicketRow = P21DispatchRow & { fulfillment_status?: string | null };

export type BranchModule = "driver-time" | "truck-capacity" | "dispatch";
export type BranchRequest = {
  module: BranchModule;
  weekStart: string;
  routeId?: string;
  runId?: string;
};

export interface BranchReadPort {
  routes(): Promise<RouteRow[]>;
  driverInputs(
    scope: BranchScope,
    weekStart: string,
    weekEnd: string,
  ): Promise<{ events: DriverEventRow[]; overrides: OverrideRow[]; thresholdMinutes: number }>;
  reconcile(events: DriverEventRow[], overrides: OverrideRow[]): ReconciledDriver[];
  capacityRuns(routeIds: string[], from: string, to: string): Promise<CapacityRunRow[]>;
  /** Must be a pure read: no forecast log, no activity events. */
  forecast(routeId: string): Promise<ForecastDto>;
  dispatchRuns(routeIds: string[]): Promise<DispatchRunRow[]>;
  dispatchStops(runId: string): Promise<DispatchStopRow[]>;
  dispatchCache(): Promise<{ rows: TicketRow[]; pulledAt: string | null }>;
  dispatchBoard(rows: TicketRow[], routes: RouteRow[]): Promise<DispatchBoard | null>;
}

export function weekWindow(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error("Invalid week");
  const start = new Date(weekStart + "T00:00:00Z");
  if (
    !Number.isFinite(start.getTime()) ||
    start.toISOString().slice(0, 10) !== weekStart ||
    start.getUTCDay() !== 1
  )
    throw new Error("Week must start on a valid Monday");
  start.setUTCDate(start.getUTCDate() + 4);
  return { weekStart, weekEnd: start.toISOString().slice(0, 10) };
}

const ticketLite = (t: DispatchBoard["stale"][number]) => ({
  pick_ticket_no: t.pick_ticket_no ?? null,
  route_code: t.route_code ?? null,
  held: !!t.held,
  hold_reason: t.hold_reason ?? null,
});

/** Strip the board to what the read-only page shows; exception authorship is not exposed. */
export function boardDto(board: DispatchBoard | null) {
  if (!board) return null;
  return {
    today: board.today,
    upcoming: (board.upcoming ?? []).map((u) => ({
      route_code: u.route_code,
      run_date: u.run_date,
      tickets: u.tickets,
      orders: u.orders,
      held: u.held,
      est_cube_ft: u.est_cube_ft,
      missing_cube: u.missing_cube,
      cancelled: u.exception?.kind === "no_run",
    })),
    stale: (board.stale ?? []).map((s) => ({
      ...ticketLite(s),
      run_date: s.run_date,
      age_days: s.age_days ?? null,
    })),
  };
}

export async function loadBranchReport(
  scope: BranchScope,
  input: BranchRequest,
  port: BranchReadPort,
) {
  const window = weekWindow(input.weekStart);
  if (!["driver-time", "truck-capacity", "dispatch"].includes(input.module))
    throw new Error("Invalid module");
  if (input.module !== "dispatch" && input.runId)
    throw new Error("Run ID is only valid for Dispatch");
  const base = {
    warehouse: scope.warehouse,
    ...window,
    readOnly: true as const,
  };

  if (input.module === "driver-time") {
    if (input.routeId) throw new Error("Route ID is not valid for Driver Time");
    const raw = await port.driverInputs(scope, window.weekStart, window.weekEnd);
    const safe = scopedDriverInputs(scope, raw.events, raw.overrides);
    const drivers = port
      .reconcile(safe.events, safe.overrides)
      .filter((d) => d.hub === scope.warehouse)
      .map(branchDriverDto);
    return {
      ...base,
      module: "driver-time" as const,
      thresholdMinutes: raw.thresholdMinutes,
      drivers,
      totals: {
        drivers: drivers.length,
        flaggedMinutes: drivers.reduce((n, d) => n + (d.flaggedMinutes ?? 0), 0),
      },
      routes: [] as RouteRow[],
    };
  }

  const allRoutes = await port.routes();
  let routes = scopedRoutes(scope, allRoutes);
  if (input.routeId) routes = [assertRoute(scope, allRoutes, input.routeId)];
  const ids = routes.map((r) => r.id);
  const routeDto = routes.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name ?? r.code,
    hub: r.hub,
  }));

  if (input.module === "truck-capacity") {
    // An empty authorized set is EMPTY, never a missing/global filter.
    const runs = ids.length
      ? scopedRouteRows(routes, await port.capacityRuns(ids, window.weekStart, window.weekEnd))
      : [];
    const forecasts = input.routeId
      ? [{ routeId: input.routeId, value: await port.forecast(input.routeId) }]
      : [];
    const latestActual = runs.reduce(
      (m: string | null, r: CapacityRunRow) => (!m || r.run_date > m ? r.run_date : m),
      null,
    );
    return {
      ...base,
      module: "truck-capacity" as const,
      routes: routeDto,
      runs,
      forecasts,
      latestActual,
    };
  }

  const runs = ids.length ? scopedRouteRows(routes, await port.dispatchRuns(ids)) : [];
  let stops: DispatchStopRow[] = [];
  if (input.runId) {
    const run = runs.find((r) => r.id === input.runId);
    if (!run) throw new Error("Run not found or access denied");
    stops = (await port.dispatchStops(run.id)).filter((s) => s.dispatch_run_id === run.id);
  }
  const cache = ids.length ? await port.dispatchCache() : { rows: [], pulledAt: null };
  const allowed = codesForRoutes(routes);
  const tickets = scopedTicketRows(scope, allRoutes, cache.rows).filter((r) =>
    allowed.has(
      String(r.route_code ?? "")
        .trim()
        .toUpperCase(),
    ),
  );
  const board = ids.length ? boardDto(await port.dispatchBoard(tickets, routes)) : null;
  const ticketDto = tickets.map((r) => ({
    pick_ticket_no: r.pick_ticket_no ?? null,
    order_no: r.order_no ?? null,
    route_code: r.route_code ?? null,
    customer_name: r.customer_name ?? null,
    fulfillment_status: r.fulfillment_status ?? null,
    est_pallets: r.est_pallets ?? null,
    est_cube_ft: r.est_cube_ft ?? null,
    est_weight_lbs: r.est_weight_lbs ?? null,
  }));
  return {
    ...base,
    module: "dispatch" as const,
    routes: routeDto,
    runs,
    stops,
    tickets: ticketDto,
    board,
    pulledAt: cache.pulledAt,
  };
}

export type BranchReport = Awaited<ReturnType<typeof loadBranchReport>>;
