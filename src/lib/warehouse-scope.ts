// Pure warehouse-scope rules for the branch_manager role. No I/O; shared by server and tests.
export const WAREHOUSES = ["Birmingham", "Dallas", "Ocala"] as const;
export type Warehouse = (typeof WAREHOUSES)[number];
export type BranchScope = { userId: string; warehouse: Warehouse };
export type Assignment = { user_id: string; warehouse: string; active: boolean };

export function isBranchManager(roles: string[]): boolean {
  return roles.includes("branch_manager");
}

/** Fails closed: exactly branch_manager, exactly one active approved warehouse (exact canonical match). */
export function resolveBranchScope(
  userId: string,
  roles: string[],
  assignments: Assignment[],
): BranchScope {
  if (!userId || !isBranchManager(roles)) throw new Error("Branch access denied");
  if (roles.some((r) => r !== "branch_manager"))
    throw new Error("Mixed branch roles require review");
  const rows = assignments.filter((a) => a.user_id === userId && a.active === true);
  if (rows.length !== 1 || !(WAREHOUSES as readonly string[]).includes(rows[0]!.warehouse))
    throw new Error("A unique approved warehouse assignment is required");
  return { userId, warehouse: rows[0]!.warehouse as Warehouse };
}

export type RouteRow = {
  id: string;
  code: string;
  hub: string | null;
  p21_route_code?: string | null;
  name?: string;
  active?: boolean;
  sort_order?: number;
};

export function scopedRoutes(scope: BranchScope, routes: RouteRow[]): RouteRow[] {
  return routes.filter((r) => r.hub === scope.warehouse);
}

export function assertRoute(scope: BranchScope, routes: RouteRow[], routeId: string): RouteRow {
  const rows = scopedRoutes(scope, routes).filter((r) => r.id === routeId);
  if (rows.length !== 1) throw new Error("Route not found or access denied");
  return rows[0]!;
}

export function scopedRouteRows<T extends { route_id?: string | null }>(
  routes: RouteRow[],
  rows: T[],
): T[] {
  const ids = new Set(routes.map((r) => r.id));
  return rows.filter((r) => !!r.route_id && ids.has(r.route_id));
}

function routeCodes(r: RouteRow): string[] {
  return String(r.p21_route_code || r.code)
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

/** P21 code -> owning hubs. Codes owned by more than one hub (or no hub) are ambiguous and excluded. */
export function uniquelyOwnedCodes(scope: BranchScope, allRoutes: RouteRow[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const r of allRoutes)
    for (const code of routeCodes(r)) {
      const s = owners.get(code) ?? new Set<string>();
      s.add(r.hub || "UNASSIGNED");
      owners.set(code, s);
    }
  const out = new Set<string>();
  for (const [code, s] of owners) if (s.size === 1 && s.has(scope.warehouse)) out.add(code);
  return out;
}

export function scopedTicketRows<T extends { route_code?: unknown }>(
  scope: BranchScope,
  allRoutes: RouteRow[],
  rows: T[],
): T[] {
  const owned = uniquelyOwnedCodes(scope, allRoutes);
  return rows.filter((r) =>
    owned.has(
      String(r.route_code ?? "")
        .trim()
        .toUpperCase(),
    ),
  );
}

export function codesForRoutes(routes: RouteRow[]): Set<string> {
  return new Set(routes.flatMap(routeCodes));
}

export type DriverEventRow = {
  id: string;
  driver_id: string;
  driver_name: string | null;
  hub: string | null;
  event_date: string;
  start_ts: string | null;
  end_ts: string | null;
  duration_min: number | null;
  address_name?: string | null;
  location_source?: string | null;
  needs_review?: boolean | null;
  status?: string | null;
  superseded_at?: string | null;
};
export type OverrideRow = {
  driver_id: string;
  week_start: string;
  warehouse_actual: ({ hub?: string | null } & Record<string, unknown>) | null;
};
/** Shape produced by buildReconciledDrivers; only the fields the branch DTO reads. */
export type ReconciledDriver = {
  driverId: string;
  driverName: string;
  hub: string | null;
  flaggedMinutes: number;
  automatedMinutes: number;
  official?: unknown;
  events?: DriverEventRow[];
};

export function scopedDriverInputs(
  scope: BranchScope,
  events: DriverEventRow[],
  overrides: OverrideRow[],
) {
  return {
    events: events.filter((e) => e.hub === scope.warehouse),
    overrides: overrides.filter((o) => o.warehouse_actual?.hub === scope.warehouse),
  };
}

/** Driver DTO: no audit history, official source notes, pay rates or paid hours. */
export function branchDriverDto(driver: ReconciledDriver) {
  return {
    driverId: driver.driverId,
    driverName: driver.driverName,
    hub: driver.hub,
    flaggedMinutes: driver.flaggedMinutes,
    automatedMinutes: driver.automatedMinutes,
    hasOfficial: driver.official != null,
    events: (driver.events ?? []).map((e) => ({
      id: e.id,
      event_date: e.event_date,
      start_ts: e.start_ts,
      end_ts: e.end_ts,
      duration_min: e.duration_min,
      address_name: e.address_name,
      needs_review: e.needs_review,
      status: e.status,
      location_source: e.location_source,
    })),
  };
}

export function denyLegacyBranchRoles(roles: string[]): void {
  if (isBranchManager(roles)) throw new Error("Use the warehouse-scoped branch reports");
}

export const BRANCH_PATHS = ["/driver-time", "/truck-capacity", "/dispatch"] as const;
export function isBranchPath(pathname: string): boolean {
  return (BRANCH_PATHS as readonly string[]).some((p) => pathname === p || pathname === p + "/");
}
