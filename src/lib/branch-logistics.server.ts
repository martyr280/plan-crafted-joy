// Server adapter for the warehouse-scoped read-only report. Reads only; never enqueues bridge jobs,
// never logs forecasts, never writes activity events.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { checkLegacyAccessWith } from "./branch-guard";
import { resolveBranchScope, uniquelyOwnedCodes } from "./warehouse-scope";
import { loadBranchReport } from "./branch-report";
import type { BranchReadPort, BranchRequest } from "./branch-report";

const db = () => supabaseAdmin as any;

export async function rolesFor(userId: string): Promise<string[]> {
  if (!userId) throw new Error("Authentication required");
  const { data, error } = await db().from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error("Unable to verify access");
  return (data ?? []).map((r: any) => String(r.role));
}

export async function checkLegacyAccess(userId: string) {
  return checkLegacyAccessWith(rolesFor, userId);
}

async function bounded(q: any, limit = 5000): Promise<any[]> {
  const { data, error } = await q.limit(limit);
  if (error) throw new Error("Unable to load warehouse report");
  if ((data?.length ?? 0) >= limit) throw new Error("Report exceeds safe limit; narrow the window");
  return data ?? [];
}

export async function readBranchLogistics(userId: string, input: BranchRequest) {
  const roles = await rolesFor(userId);
  const { data, error } = await db()
    .from("branch_manager_warehouses")
    .select("user_id,warehouse,active")
    .eq("user_id", userId);
  if (error) throw new Error("Warehouse access is not configured");
  const scope = resolveBranchScope(userId, roles, data ?? []);

  let routesMemo: Promise<any[]> | null = null;
  const port: BranchReadPort = {
    routes: () =>
      (routesMemo ??= bounded(
        db()
          .from("truck_capacity_routes")
          .select("id,code,name,hub,p21_route_code,active,sort_order"),
      )),
    driverInputs: async (s, from, to) => {
      const { getDriverTimeSettings } = await import("./driver-time.server");
      const [events, overrides, settings] = await Promise.all([
        bounded(
          db()
            .from("driver_warehouse_events")
            .select(
              "id,driver_id,driver_name,hub,event_date,start_ts,end_ts,duration_min,address_name,location_source,needs_review,status,superseded_at",
            )
            .eq("hub", s.warehouse)
            .gte("event_date", from)
            .lte("event_date", to),
        ),
        bounded(
          db()
            .from("driver_time_week_overrides")
            .select("driver_id,week_start,warehouse_actual")
            .eq("week_start", from)
            .eq("warehouse_actual->>hub", s.warehouse),
        ),
        getDriverTimeSettings(),
      ]);
      const { isExcludedDriver } = await import("./driver-time/detect");
      return {
        events: events.filter(
          (e) => !isExcludedDriver({ id: e.driver_id, name: e.driver_name }, settings as any),
        ),
        overrides,
        thresholdMinutes: settings.thresholdMinutes,
      };
    },
    reconcile: (events, overrides) => {
      // Loaded lazily below; kept sync for the port contract.
      return reconcileImpl!(events, overrides, false);
    },
    capacityRuns: (ids, from, to) =>
      bounded(
        db()
          .from("truck_capacity_runs")
          .select("id,route_id,run_date,run_seq,capacity_frac,pallet_count,returned_pallets,source")
          .in("route_id", ids)
          .gte("run_date", from)
          .lte("run_date", to)
          .order("run_date"),
      ),
    forecast: async (routeId) => {
      const { computeForecastForRoute } = await import("./truck-capacity.server");
      const result = await computeForecastForRoute(routeId, 28, "auto", { logForecast: false });
      return {
        days: result.days.map((d: any) => ({
          date: d.date,
          predicted: d.blend ?? d.forecast,
          current: d.p21,
          capacity: d.final,
          lowConfidence: d.low_confidence,
          explanation: d.explain,
        })),
      };
    },
    dispatchRuns: (ids) =>
      bounded(
        db()
          .from("dispatch_runs")
          .select(
            "id,route_id,route_code,run_date,status,stops_total,stops_held,est_pallets,est_cube_ft,est_weight_lbs,last_reconciled_at",
          )
          .in("route_id", ids)
          .order("run_date", { ascending: false }),
      ),
    dispatchStops: (runId) =>
      bounded(
        db()
          .from("dispatch_stops")
          .select(
            "id,dispatch_run_id,position,pick_ticket_no,order_no,customer_name,hold,hold_reason,state,est_pallets,est_cube_ft,est_weight_lbs",
          )
          .eq("dispatch_run_id", runId)
          .order("position"),
      ),
    dispatchCache: async () => {
      const { data: job, error: jobErr } = await db()
        .from("p21_bridge_jobs")
        .select("result,completed_at,created_at")
        .eq("kind", "sql.select")
        .eq("status", "done")
        .eq("payload->>slug", "dispatch-board")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (jobErr) throw new Error("Unable to read cached Dispatch report");
      if (job?.result?.truncated) throw new Error("Cached Dispatch report is truncated");
      return {
        rows: job?.result?.rows ?? [],
        pulledAt: job?.completed_at ?? job?.created_at ?? null,
      };
    },
    dispatchBoard: async (rows, routes) => {
      const ids = routes.map((r) => r.id);
      const { buildDispatchBoard } = await import("./dispatch/board");
      const { localDateIn, addDaysISO } = await import("./truck-capacity/cutoffs");
      const { DATE_BASES } = await import("./dispatch/assign");
      const today = localDateIn("America/Chicago", new Date());
      const owned = uniquelyOwnedCodes(scope, await port.routes());
      const cutoffs = (
        await bounded(
          db()
            .from("route_cutoffs")
            .select("route_id,p21_code,cutoff_dow,cutoff_time,run_dows,active")
            .in("route_id", ids)
            .eq("active", true),
        )
      ).filter((c) =>
        owned.has(
          String(c.p21_code ?? "")
            .trim()
            .toUpperCase(),
        ),
      );
      const codes = [...new Set(cutoffs.map((c) => String(c.p21_code)))];
      const demand = await bounded(
        db()
          .from("truck_capacity_p21_demand")
          .select(
            "route_id,ship_date,order_count,total_cube_ft,projected_capacity_frac,snapshot_at",
          )
          .in("route_id", ids)
          .gte("ship_date", today),
      );
      const exceptions = codes.length
        ? await bounded(
            db()
              .from("dispatch_run_exceptions")
              .select("id,p21_code,run_date,kind,reason")
              .in("p21_code", codes)
              .gte("run_date", addDaysISO(today, -60)),
          )
        : [];
      const { data: settings, error: sErr } = await db()
        .from("truck_capacity_settings")
        .select("dispatch_date_basis,excluded_p21_codes")
        .limit(1)
        .maybeSingle();
      if (sErr) throw new Error("Unable to verify Dispatch assignment settings");
      const basis = (DATE_BASES as string[]).includes(settings?.dispatch_date_basis)
        ? settings.dispatch_date_basis
        : "pick_ticket_print";
      return buildDispatchBoard(rows, cutoffs as any, demand as any, {
        basis,
        today,
        excludedCodes: settings?.excluded_p21_codes ?? [],
        exceptions: exceptions as any,
      });
    },
  };
  let reconcileImpl: ((e: any[], o: any[], w: boolean) => any[]) | null = null;
  if (input.module === "driver-time") {
    reconcileImpl = (await import("./driver-time/reconciliation")).buildReconciledDrivers;
  }
  return loadBranchReport(scope, input, port);
}
