// Server orchestration for Samsara Route Dispatch (build 1: no UI, no cron).
//
// Data path, and the rules that keep it honest:
//   route_cutoffs (cutoffs.ts) -> run dates
//   FRESH bridge sql.select against the dispatch view -> orders
//   build.ts -> plan (holds included)
//   diff.ts -> create-or-patch
//
// Hard invariants:
//  * The order set is ALWAYS pulled fresh through the bridge for this run. It
//    is never taken from the nightly truck-capacity snapshot and never from a
//    previous dispatch_stops row. A bridge failure aborts LOUDLY: status
//    'error', nothing persisted as if it were real data.
//  * The SQL is one SELECT, three-part-named, with no semicolons or comments —
//    the agent installed at NDI is v1.0.0 and rejects both.
//  * The view does not exist yet, so the bridge call is gated behind
//    app_settings.dispatch.viewName and returns a clear 'view not available'
//    error. buildDispatchPlanFromRows stays the pure entry for tests/fixtures.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import {
  nextCutoff,
  runDatesFor,
  zonedWallToUtc,
  type RouteCutoff,
} from "./truck-capacity/cutoffs";

import {
  buildDispatchPlanFromRows,
  externalIdFor,
  type AddressMapEntry,
  type CutoffWindow,
  type DispatchPlan,
  type DispatchPlanRun,
  type P21DispatchRow,
} from "./dispatch/build";
import type { SequenceTemplateRow } from "./dispatch/sequence";
import { diffRun } from "./dispatch/diff";
import {
  createRoute,
  deleteRoute,
  externalIdPath,
  getRouteByExternalId,
  patchRoute,
  type SamsaraRoutePayload,
} from "./samsara/routes.server";
import { cutoffsFiredSince, dueCutoffs, nextWatermark } from "./dispatch/watermark";

export { buildDispatchPlanFromRows };

const db = () => supabaseAdmin;

export type DispatchSettings = {
  enabledRouteIds: string[];
  /**
   * Routes the cron may push WITHOUT a human clicking Approve. Empty by
   * default: Phase 2 is a settings change, not a code change.
   */
  autoPushRouteIds: string[];
  depotDepartLocal: string;
  stopIncrementMin: number;
  lockOffset: string;
  geocoder: string | null;
  viewName: string;
  /** Set true only once Kevin has published the view. */
  viewAvailable: boolean;
  /** Minutes to wait after a cutoff before building (P21 finishes allocating). */
  buildDelayMin: number;
  /** Watermark: UTC ms of the last builder tick. */
  lastBuilderTickMs: number | null;
};

const DEFAULT_SETTINGS: DispatchSettings = {
  enabledRouteIds: [],
  autoPushRouteIds: [],
  depotDepartLocal: "07:00",
  stopIncrementMin: 20,
  lockOffset: "04:00",
  geocoder: null,
  viewName: "p21_analytics_play.dbo.vw_route_dispatch",
  viewAvailable: false,
  buildDelayMin: 10,
  lastBuilderTickMs: null,
};

export async function getDispatchSettings(): Promise<DispatchSettings> {
  const { data } = await db().from("app_settings").select("value").eq("key", "dispatch").maybeSingle();
  const v = (data?.value ?? {}) as Partial<DispatchSettings>;
  return { ...DEFAULT_SETTINGS, ...v };
}

export async function saveDispatchSettings(patch: Partial<DispatchSettings>): Promise<DispatchSettings> {
  const current = await getDispatchSettings();
  const next = { ...current, ...patch };
  const { error } = await db().from("app_settings").upsert({ key: "dispatch", value: next as any }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return next;
}


/* -------------------------------------------------------------- bridge SQL */

/** One SELECT, three-part name, no semicolons, no comments. */
export function buildDispatchViewSql(viewName: string, routeCode: string, runDates: string[]): string {
  const safeView = String(viewName ?? "").trim();
  if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(safeView)) {
    throw new Error(`Invalid dispatch view name: ${viewName}`);
  }
  const code = String(routeCode ?? "").replace(/'/g, "''");
  const dates = runDates
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .map((d) => `'${d}'`)
    .join(", ");
  if (!dates) throw new Error("No valid run dates for dispatch query");
  return (
    `SELECT pick_ticket_no, order_no, route_code, ship_date, customer_id, customer_name, ship_to_id, ` +
    `ship2_name, ship2_addr1, ship2_addr2, ship2_city, ship2_state, ship2_zip, delivery_instructions, ` +
    `est_weight_lbs, est_cube_ft, est_pallets, line_count, total_lines_allocated ` +
    `FROM ${safeView} WHERE route_code = '${code}' AND CAST(ship_date AS date) IN (${dates})`
  );
}

function lockAtFor(runDate: string, lockOffset: string, tz: string): string | null {
  const [hh, mm] = String(lockOffset ?? "").split(":").map(Number);
  if (!Number.isFinite(hh)) return null;
  // Lock at HH:MM local on the run day.
  const time = `${String(hh).padStart(2, "0")}:${String(mm || 0).padStart(2, "0")}`;
  return zonedWallToUtc(runDate, time, tz).toISOString();
}


/* ------------------------------------------------------------- plan builder */

export type BuildResult =
  | { ok: true; plan: DispatchPlan; bridgeJobId: string | null; runIds: string[] }
  | { ok: false; error: string };

/**
 * Build (and persist) the dispatch plan for a route's upcoming cutoff.
 * `runDate` narrows a multi-day cutoff window to one day when supplied.
 */
export async function buildDispatchPlanForRun(routeId: string, runDate?: string): Promise<BuildResult> {
  const settings = await getDispatchSettings();

  const { data: route, error: routeErr } = await db()
    .from("truck_capacity_routes")
    .select("id, code, hub, p21_route_code")
    .eq("id", routeId)
    .maybeSingle();
  if (routeErr) return { ok: false, error: `Route lookup failed: ${routeErr.message}` };
  if (!route) return { ok: false, error: "Route not found" };

  const { data: cutoffRows, error: cutErr } = await db()
    .from("route_cutoffs")
    .select("*")
    .eq("route_id", routeId)
    .eq("active", true);
  if (cutErr) return { ok: false, error: `Cutoff lookup failed: ${cutErr.message}` };
  const cutoffs = (cutoffRows ?? []) as unknown as RouteCutoff[];
  if (!cutoffs.length) return { ok: false, error: "Route has no active cutoffs" };

  const now = new Date();
  const next = nextCutoff(cutoffs, now);
  if (!next) return { ok: false, error: "No upcoming cutoff for this route" };

  const tz = next.cutoff.tz || "America/Chicago";
  let runDates = runDatesFor(next.cutoff, next.localDate);
  if (runDate) runDates = runDates.filter((d) => d === runDate);
  if (!runDates.length) {
    return { ok: false, error: runDate ? `Run date ${runDate} is not fed by the next cutoff` : "Cutoff feeds no run days" };
  }

  const routeCode = route.code as string;

  // --- FRESH bridge pull, gated behind the view's availability. ------------
  if (!settings.viewAvailable) {
    await recordRunError(routeId, routeCode, runDates, tz, settings, `view not available: ${settings.viewName}`);
    return { ok: false, error: `view not available: ${settings.viewName}` };
  }

  let rows: P21DispatchRow[] = [];
  let bridgeJobId: string | null = null;
  try {
    const sql = buildDispatchViewSql(settings.viewName, route.p21_route_code || routeCode, runDates);
    const { jobId, result } = await runJob("sql.select", { sql, slug: "dispatch" }, 60000);
    bridgeJobId = jobId as string;
    rows = ((result as any)?.rows ?? []) as P21DispatchRow[];
  } catch (e: any) {
    const msg = `Bridge query failed: ${e?.message ?? String(e)}`;
    await recordRunError(routeId, routeCode, runDates, tz, settings, msg, bridgeJobId);
    return { ok: false, error: msg };
  }

  const [{ data: mapRows }, { data: tplRows }] = await Promise.all([
    db().from("samsara_address_map").select("p21_ship_to_id, samsara_address_id, verified").limit(50000),
    db().from("route_stop_sequences").select("city_norm, state, position, delivery_dow_label, is_pickup").eq("route_id", routeId).limit(5000),
  ]);

  const plan = buildDispatchPlanFromRows(
    rows,
    (mapRows ?? []) as AddressMapEntry[],
    (tplRows ?? []) as SequenceTemplateRow[],
    {
      routeCode,
      runDates,
      cutoffAtIso: next.atUtc.toISOString(),
      lockAtIso: null,
    } satisfies CutoffWindow,
    { tz, depotDepartLocal: settings.depotDepartLocal, stopIncrementMin: settings.stopIncrementMin },
  );

  const runIds: string[] = [];
  for (const run of plan.runs) {
    const lockAt = lockAtFor(run.runDate, settings.lockOffset, tz);
    const id = await upsertRun(routeId, { ...run, lockAtIso: lockAt }, bridgeJobId);
    if (id) runIds.push(id);
  }

  return { ok: true, plan, bridgeJobId, runIds };
}

async function recordRunError(
  routeId: string,
  routeCode: string,
  runDates: string[],
  tz: string,
  settings: DispatchSettings,
  error: string,
  bridgeJobId: string | null = null,
) {
  for (const runDate of runDates) {
    await db()
      .from("dispatch_runs")
      .upsert(
        {
          route_id: routeId,
          route_code: routeCode,
          run_date: runDate,
          run_seq: 1,
          samsara_external_id: externalIdFor(routeCode, runDate, 1),
          lock_at: lockAtFor(runDate, settings.lockOffset, tz),
          status: "error",
          error,
          bridge_job_id: bridgeJobId,
        },
        { onConflict: "samsara_external_id" },
      );
  }
}

async function upsertRun(routeId: string, run: DispatchPlanRun, bridgeJobId: string | null): Promise<string | null> {
  const { data, error } = await db()
    .from("dispatch_runs")
    .upsert(
      {
        route_id: routeId,
        route_code: run.routeCode,
        run_date: run.runDate,
        run_seq: run.runSeq,
        samsara_external_id: run.externalId,
        cutoff_at: run.cutoffAtIso,
        lock_at: run.lockAtIso,
        status: run.totals.stopsHeld > 0 ? "needs_review" : "proposed",
        stops_total: run.totals.stopsTotal,
        stops_held: run.totals.stopsHeld,
        orders_total: run.totals.ordersTotal,
        est_pallets: run.totals.estPallets,
        est_cube_ft: run.totals.estCubeFt,
        est_weight_lbs: run.totals.estWeightLbs,
        bridge_job_id: bridgeJobId,
        error: null,
      },
      { onConflict: "samsara_external_id" },
    )
    .select("id")
    .single();
  if (error || !data) return null;

  const runId = data.id as string;
  await db().from("dispatch_stops").delete().eq("dispatch_run_id", runId);
  const all = [...run.stops, ...run.holds].sort((a, b) => a.position - b.position);
  if (all.length) {
    await db().from("dispatch_stops").insert(
      all.map((s) => ({
        dispatch_run_id: runId,
        position: s.position,
        run_day: s.runDay,
        pick_ticket_no: s.pickTicketNo,
        order_no: s.orderNo,
        customer_id: s.customerId,
        customer_name: s.customerName,
        p21_ship_to_id: s.p21ShipToId,
        samsara_address_id: s.samsaraAddressId,
        scheduled_arrival: s.scheduledArrival,
        stop_notes: s.stopNotes,
        est_pallets: s.estPallets,
        est_cube_ft: s.estCubeFt,
        est_weight_lbs: s.estWeightLbs,
        hold: s.hold,
        hold_reason: s.holdReason,
        state: s.state,
      })),
    );
  }
  return runId;
}

/* ------------------------------------------------------------- push/reconcile */

/** Re-hydrate a persisted dispatch_run back into the plan shape diff.ts wants. */
async function loadRunAsPlan(runId: string): Promise<{ run: DispatchPlanRun; row: any } | null> {
  const { data: row } = await db().from("dispatch_runs").select("*").eq("id", runId).maybeSingle();
  if (!row) return null;
  const { data: stops } = await db()
    .from("dispatch_stops")
    .select("*")
    .eq("dispatch_run_id", runId)
    .order("position", { ascending: true })
    .limit(5000);

  const mapped = (stops ?? []).map((s: any) => ({
    position: s.position,
    runDay: s.run_day,
    pickTicketNo: s.pick_ticket_no,
    orderNo: s.order_no,
    customerId: s.customer_id,
    customerName: s.customer_name,
    p21ShipToId: s.p21_ship_to_id,
    samsaraAddressId: s.samsara_address_id,
    scheduledArrival: s.scheduled_arrival,
    stopNotes: s.stop_notes,
    estPallets: Number(s.est_pallets ?? 0),
    estCubeFt: Number(s.est_cube_ft ?? 0),
    estWeightLbs: Number(s.est_weight_lbs ?? 0),
    hold: Boolean(s.hold),
    holdReason: s.hold_reason,
    state: s.state,
    unslotted: false,
  }));

  const run: DispatchPlanRun = {
    routeCode: row.route_code ?? "",
    runDate: row.run_date,
    runSeq: row.run_seq ?? 1,
    externalId: row.samsara_external_id ?? externalIdFor(row.route_code ?? "", row.run_date, row.run_seq ?? 1),
    cutoffAtIso: row.cutoff_at ?? new Date().toISOString(),
    lockAtIso: row.lock_at ?? null,
    stops: mapped.filter((s) => !s.hold),
    holds: mapped.filter((s) => s.hold),
    totals: {
      ordersTotal: mapped.length,
      stopsTotal: mapped.filter((s) => !s.hold).length,
      stopsHeld: mapped.filter((s) => s.hold).length,
      estPallets: Number(row.est_pallets ?? 0),
      estCubeFt: Number(row.est_cube_ft ?? 0),
      estWeightLbs: Number(row.est_weight_lbs ?? 0),
    },
  };
  return { run, row };
}

export type PushResult =
  | { ok: true; action: "create" | "patch" | "noop"; reason: string; samsaraRouteId: string | null }
  | { ok: false; error: string };

async function pushOrReconcile(runId: string, mode: "push" | "reconcile", pushedBy?: string): Promise<PushResult> {
  const loaded = await loadRunAsPlan(runId);
  if (!loaded) return { ok: false, error: "Dispatch run not found" };
  const { run, row } = loaded;

  const { data: driverMap } = await db()
    .from("dispatch_driver_map")
    .select("samsara_driver_id, confirmed")
    .eq("route_id", row.route_id)
    .maybeSingle();
  const driverId = driverMap?.confirmed ? driverMap.samsara_driver_id ?? null : null;

  let existing = null as Awaited<ReturnType<typeof getRouteByExternalId>>;
  try {
    existing = await getRouteByExternalId(run.externalId);
  } catch (e: any) {
    const msg = `Samsara lookup failed: ${e?.message ?? String(e)}`;
    await db().from("dispatch_runs").update({ status: "error", error: msg }).eq("id", runId);
    return { ok: false, error: msg };
  }

  const decision = diffRun(run, existing as any, new Date(), { driverId });
  if (decision.action === "noop") {
    if (decision.reason === "locked") {
      await db().from("dispatch_runs").update({ status: "locked" }).eq("id", runId);
    }
    await db()
      .from("dispatch_runs")
      .update({ last_reconciled_at: new Date().toISOString() })
      .eq("id", runId);
    return { ok: true, action: "noop", reason: decision.reason, samsaraRouteId: row.samsara_route_id ?? null };
  }

  try {
    const record =
      decision.action === "create"
        ? await createRoute(decision.payload as SamsaraRoutePayload)
        : await patchRoute(decision.routeId, decision.payload as Partial<SamsaraRoutePayload>);

    const stopIdByKey = new Map<string, string>();
    for (const s of record.stops ?? []) {
      const key = String((s as any)?.externalIds?.nelsonStop ?? "");
      if (key && (s as any).id) stopIdByKey.set(key, String((s as any).id));
    }
    for (const s of run.stops) {
      const key = `${run.externalId}:${s.orderNo ?? ""}:${s.p21ShipToId ?? ""}`;
      const sid = stopIdByKey.get(key);
      if (!sid) continue;
      await db()
        .from("dispatch_stops")
        .update({ samsara_stop_id: sid })
        .eq("dispatch_run_id", runId)
        .eq("position", s.position);
    }

    await db()
      .from("dispatch_runs")
      .update({
        status: "pushed",
        samsara_route_id: String(record.id ?? row.samsara_route_id ?? ""),
        pushed_payload: decision.payload as any,
        pushed_at: mode === "push" ? new Date().toISOString() : row.pushed_at,
        pushed_by: mode === "push" ? pushedBy ?? null : row.pushed_by,
        last_reconciled_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", runId);

    return {
      ok: true,
      action: decision.action,
      reason: decision.reason,
      samsaraRouteId: String(record.id ?? ""),
    };
  } catch (e: any) {
    const msg = `Samsara ${decision.action} failed: ${e?.message ?? String(e)}`;
    await db().from("dispatch_runs").update({ status: "error", error: msg }).eq("id", runId);
    return { ok: false, error: msg };
  }
}

/** Create-or-patch the Samsara route for a dispatch run. */
export function pushRun(runId: string, pushedBy?: string): Promise<PushResult> {
  return pushOrReconcile(runId, "push", pushedBy);
}

/** Re-pull from Samsara, diff, and patch only the deltas. Respects the lock. */
export function reconcileRun(runId: string): Promise<PushResult> {
  return pushOrReconcile(runId, "reconcile");
}

/* ------------------------------------------------------------ preview/cancel */

export type DeltaPreview = {
  ok: boolean;
  action: "create" | "patch" | "noop";
  reason: string;
  error?: string;
  changes: Array<{ kind: "add" | "remove" | "retime" | "assign"; label: string; detail: string }>;
};

/** Diff against live Samsara WITHOUT writing anything. */
export async function previewRunDelta(runId: string): Promise<DeltaPreview> {
  const loaded = await loadRunAsPlan(runId);
  if (!loaded) return { ok: false, action: "noop", reason: "not_found", error: "Dispatch run not found", changes: [] };
  const { run, row } = loaded;

  const { data: driverMap } = await db()
    .from("dispatch_driver_map")
    .select("samsara_driver_id, confirmed")
    .eq("route_id", row.route_id)
    .maybeSingle();
  const driverId = driverMap?.confirmed ? driverMap.samsara_driver_id ?? null : null;

  let existing: any = null;
  try {
    existing = await getRouteByExternalId(run.externalId);
  } catch (e: any) {
    return { ok: false, action: "noop", reason: "samsara_error", error: e?.message ?? String(e), changes: [] };
  }

  const decision = diffRun(run, existing, new Date(), { driverId });
  const changes: DeltaPreview["changes"] = [];

  if (decision.action === "create") {
    for (const s of (decision.payload.stops ?? [])) {
      changes.push({ kind: "add", label: String(s.name ?? ""), detail: String(s.scheduledArrivalTime ?? "") });
    }
  } else if (decision.action === "patch") {
    const keyOf = (s: any) => String(s?.externalIds?.nelsonStop ?? s?.id ?? s?.name ?? "");
    const before = new Map<string, any>((existing?.stops ?? []).map((s: any) => [keyOf(s), s]));
    const after = new Map<string, any>((decision.payload.stops ?? []).map((s: any) => [keyOf(s), s]));
    for (const [k, s] of after) {
      const prev = before.get(k);
      if (!prev) changes.push({ kind: "add", label: String(s.name ?? k), detail: String(s.scheduledArrivalTime ?? "") });
      else if (String(prev.scheduledArrivalTime ?? "") !== String(s.scheduledArrivalTime ?? "")) {
        changes.push({
          kind: "retime",
          label: String(s.name ?? k),
          detail: `${prev.scheduledArrivalTime ?? "?"} → ${s.scheduledArrivalTime ?? "?"}`,
        });
      }
    }
    for (const [k, s] of before) {
      if (!after.has(k)) changes.push({ kind: "remove", label: String(s.name ?? k), detail: String(s.scheduledArrivalTime ?? "") });
    }
    const beforeAssign = String(existing?.driverId ?? existing?.vehicleId ?? "");
    const afterAssign = String(decision.payload.driverId ?? decision.payload.vehicleId ?? "");
    if (beforeAssign !== afterAssign) {
      changes.push({ kind: "assign", label: "Assignment", detail: `${beforeAssign || "unassigned"} → ${afterAssign || "unassigned"}` });
    }
  }

  return { ok: true, action: decision.action, reason: decision.reason, changes };
}

export type CancelResult = { ok: boolean; deletedInSamsara: boolean; error?: string };

/**
 * Cancel a run. The Samsara route is deleted only when we actually pushed it and
 * the lock has not passed; past the lock we leave Samsara alone (a driver may
 * already be running it) and only mark our record cancelled.
 */
export async function cancelDispatchRun(runId: string): Promise<CancelResult> {
  const { data: row } = await db().from("dispatch_runs").select("*").eq("id", runId).maybeSingle();
  if (!row) return { ok: false, deletedInSamsara: false, error: "Dispatch run not found" };

  const lockMs = row.lock_at ? Date.parse(row.lock_at) : NaN;
  const beforeLock = !Number.isFinite(lockMs) || Date.now() < lockMs;
  let deleted = false;
  if (row.status === "pushed" && beforeLock && (row.samsara_route_id || row.samsara_external_id)) {
    try {
      await deleteRoute(String(row.samsara_route_id || externalIdPath(String(row.samsara_external_id ?? ""))));
      deleted = true;
    } catch (e: any) {
      await db().from("dispatch_runs").update({ status: "cancelled", error: `Samsara delete failed: ${e?.message ?? String(e)}` }).eq("id", runId);
      return { ok: false, deletedInSamsara: false, error: e?.message ?? String(e) };
    }
  }
  await db().from("dispatch_runs").update({ status: "cancelled", error: null }).eq("id", runId);
  return { ok: true, deletedInSamsara: deleted };
}

/* ---------------------------------------------------------------- cron ticks */

export type BuilderTickResult = {
  ok: boolean;
  watermarkFrom: number;
  watermarkTo: number;
  builds: Array<{ routeId: string; routeCode: string; runDates: string[]; ok: boolean; error?: string; runIds?: string[] }>;
  pushes: Array<{ runId: string; ok: boolean; action?: string; error?: string }>;
  skippedNotDue: number;
};

/**
 * Builder tick. Enabled routes only; shadow-mode routes (enabled off) are not
 * built by cron at all — Joe builds those by hand from the board.
 *
 * Auto-push requires BOTH enabled and autoPush for the route.
 */
export async function runDispatchBuilderTick(now: Date = new Date()): Promise<BuilderTickResult> {
  const settings = await getDispatchSettings();
  const nowMs = now.getTime();
  const from = settings.lastBuilderTickMs ?? nowMs - 15 * 60_000;
  const result: BuilderTickResult = {
    ok: true, watermarkFrom: from, watermarkTo: nowMs, builds: [], pushes: [], skippedNotDue: 0,
  };
  const routeIds = settings.enabledRouteIds ?? [];
  if (!routeIds.length) {
    await saveDispatchSettings({ lastBuilderTickMs: nowMs });
    result.watermarkTo = nowMs;
    return result;
  }

  const { data: cutoffRows } = await db()
    .from("route_cutoffs")
    .select("*")
    .in("route_id", routeIds)
    .eq("active", true)
    .limit(2000);
  const { data: routes } = await db()
    .from("truck_capacity_routes")
    .select("id, code")
    .in("id", routeIds)
    .limit(2000);
  const codeById = new Map((routes ?? []).map((r: any) => [r.id as string, r.code as string]));

  const allFired = cutoffsFiredSince((cutoffRows ?? []) as unknown as RouteCutoff[], from, nowMs, settings.buildDelayMin);
  const due = dueCutoffs(allFired, nowMs);
  result.skippedNotDue = allFired.length - due.length;

  for (const f of due) {
    const routeId = f.cutoff.route_id;
    const routeCode = codeById.get(routeId) ?? "";
    for (const runDate of f.runDates) {
      try {
        const built = await buildDispatchPlanForRun(routeId, runDate);
        result.builds.push({
          routeId, routeCode, runDates: [runDate],
          ok: built.ok,
          error: built.ok ? undefined : built.error,
          runIds: built.ok ? built.runIds : undefined,
        });
        if (built.ok && (settings.autoPushRouteIds ?? []).includes(routeId)) {
          for (const runId of built.runIds) {
            try {
              const p = await pushRun(runId);
              result.pushes.push({ runId, ok: p.ok, action: p.ok ? p.action : undefined, error: p.ok ? undefined : p.error });
            } catch (e: any) {
              result.pushes.push({ runId, ok: false, error: e?.message ?? String(e) });
            }
          }
        }
      } catch (e: any) {
        result.builds.push({ routeId, routeCode, runDates: [runDate], ok: false, error: e?.message ?? String(e) });
      }
    }
  }

  const watermark = nextWatermark(allFired, nowMs);
  await saveDispatchSettings({ lastBuilderTickMs: watermark });
  result.watermarkTo = watermark;
  return result;
}

export type ReconcilerTickResult = {
  ok: boolean;
  reconciled: Array<{ runId: string; ok: boolean; action?: string; error?: string }>;
  locked: string[];
};

/** Reconcile pushed runs before their lock; flip pushed -> locked at the lock. */
export async function runDispatchReconcilerTick(now: Date = new Date()): Promise<ReconcilerTickResult> {
  const nowIso = now.toISOString();
  const out: ReconcilerTickResult = { ok: true, reconciled: [], locked: [] };

  const { data: rows } = await db()
    .from("dispatch_runs")
    .select("id, lock_at")
    .eq("status", "pushed")
    .limit(500);

  for (const r of rows ?? []) {
    const lockMs = r.lock_at ? Date.parse(r.lock_at) : NaN;
    if (Number.isFinite(lockMs) && now.getTime() >= lockMs) {
      await db().from("dispatch_runs").update({ status: "locked" }).eq("id", r.id);
      out.locked.push(r.id as string);
      continue;
    }
    try {
      const res = await reconcileRun(r.id as string);
      out.reconciled.push({ runId: r.id as string, ok: res.ok, action: res.ok ? res.action : undefined, error: res.ok ? undefined : res.error });
    } catch (e: any) {
      out.reconciled.push({ runId: r.id as string, ok: false, error: e?.message ?? String(e) });
    }
  }
  void nowIso;
  return out;
}
