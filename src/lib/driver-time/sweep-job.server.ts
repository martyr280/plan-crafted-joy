// Resumable Driver Warehouse Time sweep (server-only).
//
// A run is a row in driver_warehouse_runs advanced one small unit at a time by
// the driver-time tick. Phases:
//   init -> fetch_hos -> fetch_assign -> plan_vehicles -> fetch_gps -> detect -> finalize
// Every unit's writes are idempotent, and the cursor advances only after they
// return, in the same lease-guarded UPDATE that renews the heartbeat. A kill at
// any point repeats at most one unit. Detection inputs and rules are exactly
// the old single-shot sweep's (see the parity tests). No emails, no notifications.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  fetchAddresses,
  fetchDriverVehicleAssignments,
  fetchDrivers,
  fetchHosLogs,
  fetchVehicleGpsHistory,
  type NormalizedHosSegment,
  type SamsaraAssignment,
} from "@/lib/samsara/hos.server";
import {
  appendGpsChunk,
  beginCacheDay,
  countCacheDayRows,
  finishCacheDay,
  freshCacheDays,
  readEntityRows,
  writeCacheDay,
  type GpsSample,
} from "@/lib/samsara/cache.server";
import {
  backfillSegmentVehicles,
  centralDaysCovering,
  dominantVehiclePerDriverDay,
  type AssignmentRow,
  type CacheDay,
} from "@/lib/samsara/cache-window";
import { detectWarehouseEvents, type HosSegment } from "@/lib/driver-time/detect";
import type { Geofence } from "@/lib/driver-time/geo";
import { CENTRAL_TZ, dateStrInTz } from "@/lib/driver-time/tz";
import { fetchAllRows } from "@/lib/supabase-fetch-all";
import { describeCursor, GPS_VEHICLES_PER_UNIT } from "@/lib/driver-time/sweep-progress";

export { describeCursor, GPS_VEHICLES_PER_UNIT };

const db = () => supabaseAdmin as any;

export const TICK_BUDGET_MS = 15_000;
export const LEASE_MS = 90_000;
export const STALL_MS = 15 * 60_000;
export const MAX_UNIT_FAILURES = 5;
export const PLAN_DRIVERS_PER_UNIT = 10;
const STEP_LOG_KEEP = 50;

export type Phase = "init" | "fetch_hos" | "fetch_assign" | "plan_vehicles" | "fetch_gps" | "detect" | "finalize";

type RosterDriver = { id: string; name: string; timezone: string | null; eldDayStartHour: number | null; tags: string[] };

export type SweepCursor = {
  v?: 1;
  /** Enqueue instant for scheduled runs (label + window anchor). */
  nowMs?: number;
  startMs?: number;
  endMs?: number;
  /** Selected-week mode: events outside [weekStart, weekEnd] are not written. */
  selected?: boolean;
  weekStart?: string;
  weekEnd?: string;
  roster?: RosterDriver[];
  knownIds?: string[];
  rosterCounts?: unknown;
  warehouses?: Geofence[];
  settings?: {
    thresholdMinutes: number;
    mergeGapMinutes: number;
    excludedDriverIds: string[];
    excludedDriverNamePatterns: string[];
    basis: "presence" | "onduty";
    warehouseRemarkDriverIds: string[];
  };
  days?: CacheDay[];
  /** Frozen once the dataset's days are all fresh: date -> day id. */
  hosDayIds?: Record<string, string>;
  assignDayIds?: Record<string, string>;
  gpsDayIds?: Record<string, string>;
  assignmentsFailed?: boolean;
  dayIdx?: number;
  planIdx?: number;
  vehicleIds?: string[];
  gpsDayIdx?: number;
  gpsChunkIdx?: number;
  detectIdx?: number;
  counters?: { inserted: number; updated: number; reopened: number; eventsFound: number; driversScanned: number };
  warnings?: string[];
  failures?: { key: string; count: number; error: string } | null;
  /** Times a fetch phase had to go back for a day that went stale (bounded). */
  rechecks?: number;
};

export type RunRow = {
  id: string;
  status: string;
  phase: Phase | null;
  cursor: SweepCursor | null;
  week_start: string;
  week_end: string;
  requested_week_start: string | null;
  refresh_hos: boolean;
  created_at: string;
  started_at: string;
  lease_until: string | null;
  steps: number;
  step_log: unknown[] | null;
  days_fetched: number;
};

export type UnitResult = {
  phase: Phase | "completed" | "failed";
  next: Phase | "completed" | "failed";
  unit: string;
  cursor: SweepCursor;
  rows?: number;
  inserted?: number;
  /** Final status payload when the run ends. */
  final?: { status: "completed" | "failed"; error: string | null; driversScanned: number; eventsFound: number };
  daysFetched?: number;
  driversTotal?: number;
  windowStart?: string;
  windowEnd?: string;
};

/* ------------------------------------------------------------------ helpers */

const iso = (ms: number) => new Date(ms).toISOString();

function freezeIds(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries(map);
}

/* -------------------------------------------------------------------- units */

async function unitInit(run: RunRow, nowMs: number): Promise<UnitResult> {
  const { computeSweepWindow, getDriverTimeSettings, filterRoster } = await import("@/lib/driver-time.server");
  const c: SweepCursor = { ...(run.cursor ?? {}) };
  const selectedWeek = run.requested_week_start ?? undefined;
  const w = computeSweepWindow({ now: new Date(nowMs), weekStart: selectedWeek });
  const settings = await getDriverTimeSettings();
  const [drivers, addresses] = await Promise.all([fetchDrivers(), fetchAddresses()]);
  const base = {
    ...c,
    v: 1 as const,
    startMs: w.startMs,
    endMs: w.endMs,
    selected: Boolean(selectedWeek),
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
  };
  const selected = settings.warehouseAddressIds.length
    ? addresses.filter((a) => settings.warehouseAddressIds.includes(a.id))
    : [];
  if (!selected.length) {
    return {
      phase: "init",
      next: "failed",
      unit: "init",
      cursor: base,
      final: {
        status: "failed",
        error:
          "No warehouse addresses selected. Pick the warehouse geofences in Driver Time → Settings before running a sweep.",
        driversScanned: 0,
        eventsFound: 0,
      },
    };
  }
  const warehouses: Geofence[] = selected.map((a) => ({
    id: a.id,
    name: a.name,
    hub: a.name,
    tz: settings.hubTzByAddress[a.id] ?? null,
    circle: a.circle,
    polygon: a.polygon,
  }));
  const { roster, counts } = filterRoster(drivers, settings, dateStrInTz(new Date(w.startMs), CENTRAL_TZ));
  if (!roster.length) {
    return {
      phase: "init",
      next: "failed",
      unit: "init",
      cursor: base,
      final: {
        status: "failed",
        error: `No drivers to scan after exclusions (roster ${counts.total}, pattern ${counts.excludedByPattern}, no licence ${counts.excludedNoLicense}, deactivated ${counts.excludedDeactivated}).`,
        driversScanned: 0,
        eventsFound: 0,
      },
    };
  }
  const fetchEnd = Math.min(w.endMs, nowMs);
  const cursor: SweepCursor = {
    ...base,
    roster: roster.map((d) => ({
      id: String(d.id),
      name: d.name,
      timezone: d.timezone ?? null,
      eldDayStartHour: d.eldDayStartHour ?? null,
      tags: (d as any).tags ?? [],
    })),
    knownIds: drivers.map((d) => String(d.id)),
    rosterCounts: counts,
    warehouses,
    settings: {
      thresholdMinutes: settings.thresholdMinutes,
      mergeGapMinutes: settings.mergeGapMinutes,
      excludedDriverIds: settings.excludedDriverIds,
      excludedDriverNamePatterns: settings.excludedDriverNamePatterns,
      basis: settings.basis,
      warehouseRemarkDriverIds: settings.warehouseRemarkDriverIds,
    },
    days: fetchEnd > w.startMs ? centralDaysCovering(w.startMs, fetchEnd) : [],
    dayIdx: 0,
    planIdx: 0,
    vehicleIds: [],
    gpsDayIdx: 0,
    gpsChunkIdx: 0,
    detectIdx: 0,
    counters: { inserted: 0, updated: 0, reopened: 0, eventsFound: 0, driversScanned: 0 },
    warnings: [],
    failures: null,
  };
  return {
    phase: "init",
    next: "fetch_hos",
    unit: "init",
    cursor,
    driversTotal: roster.length,
    windowStart: iso(w.startMs),
    windowEnd: iso(w.endMs),
  };
}

/** fetch_hos / fetch_assign: one Central day for the whole roster. */
async function unitFetchDay(run: RunRow, dataset: "hos_logs" | "assignments", nowMs: number): Promise<UnitResult> {
  const c = { ...(run.cursor as SweepCursor) };
  const phase: Phase = dataset === "hos_logs" ? "fetch_hos" : "fetch_assign";
  const days = c.days ?? [];
  const ids = (c.roster ?? []).map((d) => d.id);
  const idx = c.dayIdx ?? 0;
  if (idx >= days.length) {
    // All days handled: freeze the day ids the detect phase will read.
    const fresh = await freshCacheDays(dataset, days, ids, nowMs);
    const missing = days.filter((d) => !fresh.has(d.date));
    if (missing.length && !(dataset === "assignments" && c.assignmentsFailed)) {
      // A day went stale between its fetch and now (open-day TTL): fetch it again.
      if ((c.rechecks ?? 0) >= 3) throw new Error(`${dataset} days ${missing.map((d) => d.date).join(",")} never became fresh`);
      c.rechecks = (c.rechecks ?? 0) + 1;
      return { phase, next: phase, unit: `recheck ${missing.map((d) => d.date).join(",")}`, cursor: { ...c, dayIdx: days.indexOf(missing[0]) } };
    }
    const frozen = freezeIds(fresh);
    const next: Phase = dataset === "hos_logs" ? "fetch_assign" : "plan_vehicles";
    return {
      phase,
      next,
      unit: "freeze days",
      cursor: dataset === "hos_logs" ? { ...c, hosDayIds: frozen, dayIdx: 0 } : { ...c, assignDayIds: frozen, dayIdx: 0 },
    };
  }
  const day = days[idx];
  const forceRefresh = dataset === "hos_logs" && run.refresh_hos && !(c as any)[`refreshed_${day.date}`];
  const fresh = forceRefresh ? new Map<string, string>() : await freshCacheDays(dataset, [day], ids, nowMs);
  if (fresh.has(day.date)) {
    return { phase, next: phase, unit: `${day.date} cached`, cursor: { ...c, dayIdx: idx + 1 } };
  }
  const dayEnd = Math.min(day.endMs, nowMs);
  let rows: Array<NormalizedHosSegment | SamsaraAssignment> = [];
  if (dayEnd > day.startMs) {
    rows =
      dataset === "hos_logs"
        ? await fetchHosLogs({ startMs: day.startMs, endMs: dayEnd, driverIds: ids })
        : await fetchDriverVehicleAssignments({ startMs: day.startMs, endMs: dayEnd, driverIds: ids });
  }
  await writeCacheDay(
    dataset,
    day,
    rows.map((r: any) => ({
      entityKind: "driver",
      entityId: r.driverId,
      startMs: r.startMs,
      endMs: r.endMs,
      payload: r,
    })),
    day.endMs <= nowMs,
    null,
    ids,
  );
  const next = { ...c, dayIdx: idx + 1 } as any;
  if (forceRefresh) next[`refreshed_${day.date}`] = true;
  return { phase, next: phase, unit: `${day.date} fetched`, cursor: next, rows: rows.length, daysFetched: 1 };
}

function inWindowSeg(s: { startMs: number; endMs: number }, a: number, b: number) {
  return s.endMs > a && s.startMs < b;
}
function inWindowAssign(x: { startMs: number; endMs: number | null }, a: number, b: number) {
  return (x.endMs ?? Number.MAX_SAFE_INTEGER) > a && x.startMs < b;
}

/** One driver's detection inputs, exactly as getDriverTimeInputs built them. */
async function driverInputs(c: SweepCursor, driverId: string) {
  const startMs = c.startMs!;
  const endMs = c.endMs!;
  const hosIds = Object.values(c.hosDayIds ?? {});
  const assignIds = Object.values(c.assignDayIds ?? {});
  const segments = (await readEntityRows<NormalizedHosSegment>("hos_logs", driverId, hosIds)).filter((s) =>
    inWindowSeg(s, startMs, endMs),
  );
  const assignments = c.assignmentsFailed
    ? []
    : (await readEntityRows<SamsaraAssignment>("assignments", driverId, assignIds)).filter((a) =>
        inWindowAssign(a, startMs, endMs),
      );
  const assignmentRows: AssignmentRow[] = assignments.map((a) => ({
    driverId: a.driverId,
    vehicleId: a.vehicleId,
    startMs: a.startMs,
    endMs: a.endMs,
  }));
  const dayVehicles = dominantVehiclePerDriverDay(assignmentRows);
  const { segments: filled } = backfillSegmentVehicles(segments, assignmentRows, dayVehicles);
  const vehicleIds = Array.from(
    new Set(
      [...filled.map((s) => s.vehicleId), ...dayVehicles.values()].filter(
        (v): v is string => Boolean(v) && v !== "0",
      ),
    ),
  );
  return { segments: filled, vehicleIds };
}

async function unitPlanVehicles(run: RunRow): Promise<UnitResult> {
  const c = { ...(run.cursor as SweepCursor) };
  const roster = c.roster ?? [];
  const idx = c.planIdx ?? 0;
  if (idx >= roster.length) {
    return { phase: "plan_vehicles", next: "fetch_gps", unit: "vehicles planned", cursor: { ...c, gpsDayIdx: 0, gpsChunkIdx: 0 } };
  }
  const set = new Set(c.vehicleIds ?? []);
  const batch = roster.slice(idx, idx + PLAN_DRIVERS_PER_UNIT);
  for (const d of batch) {
    const { vehicleIds } = await driverInputs(c, d.id);
    for (const v of vehicleIds) set.add(v);
  }
  return {
    phase: "plan_vehicles",
    next: "plan_vehicles",
    unit: `drivers ${idx + 1}-${idx + batch.length}`,
    cursor: { ...c, planIdx: idx + batch.length, vehicleIds: [...set].sort() },
  };
}

/** fetch_gps: one day x GPS_VEHICLES_PER_UNIT vehicles, append-only. */
async function unitFetchGps(run: RunRow, nowMs: number): Promise<UnitResult> {
  const c = { ...(run.cursor as SweepCursor) };
  const days = c.days ?? [];
  const vehicles = c.vehicleIds ?? [];
  const dIdx = c.gpsDayIdx ?? 0;
  if (!vehicles.length || dIdx >= days.length) {
    const fresh = vehicles.length ? await freshCacheDays("gps", days, vehicles, nowMs) : new Map<string, string>();
    const missing = vehicles.length ? days.filter((d) => !fresh.has(d.date)) : [];
    if (missing.length) {
      if ((c.rechecks ?? 0) >= 3) throw new Error(`GPS days ${missing.map((d) => d.date).join(",")} never became fresh`);
      c.rechecks = (c.rechecks ?? 0) + 1;
      return {
        phase: "fetch_gps",
        next: "fetch_gps",
        unit: `recheck ${missing.map((d) => d.date).join(",")}`,
        cursor: { ...c, gpsDayIdx: days.indexOf(missing[0]), gpsChunkIdx: 0 },
      };
    }
    return { phase: "fetch_gps", next: "detect", unit: "freeze GPS days", cursor: { ...c, gpsDayIds: freezeIds(fresh), detectIdx: 0 } };
  }
  const day = days[dIdx];
  const chunkIdx = c.gpsChunkIdx ?? 0;
  if (chunkIdx === 0) {
    const fresh = await freshCacheDays("gps", [day], vehicles, nowMs);
    if (fresh.has(day.date)) {
      return { phase: "fetch_gps", next: "fetch_gps", unit: `${day.date} cached`, cursor: { ...c, gpsDayIdx: dIdx + 1, gpsChunkIdx: 0 } };
    }
  }
  // Mark the day unreadable while it is being filled (coverage [] -> stale).
  const dayId = await beginCacheDay("gps", day);
  const chunk = vehicles.slice(chunkIdx * GPS_VEHICLES_PER_UNIT, (chunkIdx + 1) * GPS_VEHICLES_PER_UNIT);
  const dayEnd = Math.min(day.endMs, nowMs);
  const samples =
    dayEnd > day.startMs ? await fetchVehicleGpsHistory({ startMs: day.startMs, endMs: dayEnd, vehicleIds: chunk }) : [];
  const res = await appendGpsChunk(day, dayId, chunk, samples as GpsSample[]);
  const lastChunk = (chunkIdx + 1) * GPS_VEHICLES_PER_UNIT >= vehicles.length;
  if (lastChunk) {
    await finishCacheDay("gps", day, dayId, {
      complete: day.endMs <= nowMs,
      error: null,
      coverage: vehicles,
      rowCount: await countCacheDayRows(dayId),
    });
  }
  return {
    phase: "fetch_gps",
    next: "fetch_gps",
    unit: `${day.date} vehicles ${chunk.join(",")}`,
    cursor: lastChunk ? { ...c, gpsDayIdx: dIdx + 1, gpsChunkIdx: 0 } : { ...c, gpsChunkIdx: chunkIdx + 1 },
    rows: samples.length,
    inserted: res.inserted,
    daysFetched: lastChunk ? 1 : 0,
  };
}

async function unitDetect(run: RunRow): Promise<UnitResult> {
  const { offsetForTz } = await import("@/lib/driver-time.server");
  const c = { ...(run.cursor as SweepCursor) };
  const roster = c.roster ?? [];
  const idx = c.detectIdx ?? 0;
  if (idx >= roster.length) return { phase: "detect", next: "finalize", unit: "all drivers detected", cursor: c };
  const d = roster[idx];
  const startMs = c.startMs!;
  const endMs = c.endMs!;
  const s = c.settings!;
  const counters = { ...(c.counters ?? { inserted: 0, updated: 0, reopened: 0, eventsFound: 0, driversScanned: 0 }) };
  const { segments, vehicleIds } = await driverInputs(c, d.id);
  if (!segments.length) {
    return { phase: "detect", next: "detect", unit: `${d.name}: no logs`, cursor: { ...c, detectIdx: idx + 1 } };
  }
  const gpsIds = Object.values(c.gpsDayIds ?? {});
  const gps: GpsSample[] = [];
  for (const v of vehicleIds) {
    gps.push(...(await readEntityRows<GpsSample>("gps", v, gpsIds)).filter((g) => g.timeMs >= startMs && g.timeMs < endMs));
  }
  const events = detectWarehouseEvents({
    driver: { id: d.id, name: d.name },
    segments: segments as HosSegment[],
    warehouses: c.warehouses ?? [],
    gpsSamples: gps,
    options: {
      thresholdMinutes: s.thresholdMinutes,
      mergeGapMinutes: s.mergeGapMinutes,
      eldDayStartHour: d.eldDayStartHour ?? 0,
      tzOffsetMinutes: offsetForTz(d.timezone, new Date(startMs)),
      excludedDriverIds: s.excludedDriverIds,
      excludedDriverNamePatterns: s.excludedDriverNamePatterns,
      basis: s.basis,
      hubTags: d.tags ?? [],
      remarkRule: s.warehouseRemarkDriverIds.includes(d.id),
    },
  });
  const r = await reconcileDriver(run.id, d.id, events, {
    startMs,
    endMs,
    selected: Boolean(c.selected),
    weekStart: c.weekStart!,
    weekEnd: c.weekEnd!,
  });
  counters.inserted += r.inserted;
  counters.updated += r.updated;
  counters.reopened += r.reopened;
  counters.eventsFound += events.length;
  return {
    phase: "detect",
    next: "detect",
    unit: `${d.name}: ${events.length} events`,
    cursor: { ...c, detectIdx: idx + 1, counters },
    inserted: r.inserted,
  };
}

/**
 * Same reconciliation as the old sweep, for one driver. Every row written is
 * stamped run_id = this run, which is what finalize uses in place of the old
 * in-memory `seen` set.
 */
export async function reconcileDriver(
  runId: string,
  driverId: string,
  events: ReturnType<typeof detectWarehouseEvents>,
  w: { startMs: number; endMs: number; selected: boolean; weekStart: string; weekEnd: string },
) {
  let inserted = 0;
  let updated = 0;
  let reopened = 0;
  const { data: existing, error: existingError } = await db()
    .from("driver_warehouse_events")
    .select("id, driver_id, start_ts, end_ts, duration_min, status, superseded_at")
    .eq("driver_id", driverId)
    .gte("start_ts", iso(w.startMs))
    .lt("start_ts", iso(w.endMs))
    .limit(10000);
  if (existingError) throw new Error(existingError.message);
  if ((existing?.length ?? 0) >= 10000) throw new Error("Rescan range exceeds the reconciliation limit.");
  const existingMap = new Map<string, any>();
  for (const row of existing ?? []) existingMap.set(`${row.driver_id}|${new Date(row.start_ts).toISOString()}`, row);
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const ev of events) {
    if (w.selected && (ev.eventDate < w.weekStart || ev.eventDate > w.weekEnd)) continue;
    const startIso = iso(ev.startMs);
    const eventKey = `${ev.driverId}|${startIso}`;
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const prior = existingMap.get(eventKey);
    const payload = {
      run_id: runId,
      driver_id: ev.driverId,
      driver_name: ev.driverName,
      event_date: ev.eventDate,
      start_ts: startIso,
      end_ts: iso(ev.endMs),
      duration_min: ev.durationMin,
      address_id: ev.addressId,
      address_name: ev.addressName,
      hub: ev.hub,
      statuses: ev.statuses,
      location_source: ev.locationSource,
      needs_review: ev.needsReview,
      superseded_at: null,
      ...(ev.locationSource === "remark" && ev.notes ? { notes: ev.notes } : {}),
    };
    if (!prior) {
      const { error } = await db().from("driver_warehouse_events").insert({ ...payload, status: "new" });
      if (error) failures.push(`insert failed for ${ev.driverName ?? ev.driverId} @ ${startIso}: ${error.message}`);
      else inserted++;
      continue;
    }
    const timingChanged =
      prior.duration_min !== ev.durationMin || new Date(prior.end_ts).toISOString() !== payload.end_ts;
    const patch: any = { ...payload };
    if (timingChanged && prior.status !== "new") {
      patch.status = "new";
      patch.reviewed_by = null;
      patch.reviewed_at = null;
      reopened++;
    }
    const { error } = await db().from("driver_warehouse_events").update(patch).eq("id", prior.id);
    if (error) failures.push(`update failed for id ${prior.id}: ${error.message}`);
    else updated++;
  }
  if (failures.length) throw new Error(`Event reconciliation incomplete: ${failures.join(" | ")}`);
  return { inserted, updated, reopened };
}

async function unitFinalize(run: RunRow): Promise<UnitResult> {
  const c = run.cursor as SweepCursor;
  const startMs = c.startMs!;
  const endMs = c.endMs!;
  const retirable = new Set([...(c.roster ?? []).map((d) => d.id), ...(c.knownIds ?? [])]);
  type Ev = { id: string; driver_id: string; start_ts: string; end_ts: string; superseded_at: string | null; run_id: string | null };
  const rows = await fetchAllRows<Ev>(
    () =>
      db()
        .from("driver_warehouse_events")
        .select("id, driver_id, start_ts, end_ts, superseded_at, run_id", { count: "exact" })
        .gte("start_ts", iso(startMs))
        .lt("start_ts", iso(endMs)),
    { label: "driver-time finalize", orderBy: [{ column: "id" }] },
  );
  const stale = rows.filter(
    (e) =>
      retirable.has(String(e.driver_id)) &&
      !e.superseded_at &&
      Date.parse(e.start_ts) > startMs &&
      Date.parse(e.end_ts) < endMs &&
      e.run_id !== run.id,
  );
  for (let i = 0; i < stale.length; i += 200) {
    const { error } = await db()
      .from("driver_warehouse_events")
      .update({ superseded_at: new Date().toISOString() })
      .in(
        "id",
        stale.slice(i, i + 200).map((e) => e.id),
      );
    if (error) throw new Error(error.message);
  }
  const warnings = c.warnings ?? [];
  return {
    phase: "finalize",
    next: "completed",
    unit: `retired ${stale.length}`,
    cursor: c,
    final: {
      status: "completed",
      error: warnings.length ? warnings.slice(0, 5).join(" | ") : null,
      driversScanned: (c.roster ?? []).length,
      eventsFound: c.counters?.eventsFound ?? 0,
    },
  };
}

/** Run exactly one unit of work for the run's current phase. Pure of run-row writes. */
export async function runUnit(run: RunRow, nowMs: number = Date.now()): Promise<UnitResult> {
  const phase = (run.phase ?? "init") as Phase;
  switch (phase) {
    case "init":
      return unitInit(run, Number(run.cursor?.nowMs ?? nowMs));
    case "fetch_hos":
      return unitFetchDay(run, "hos_logs", nowMs);
    case "fetch_assign":
      try {
        return await unitFetchDay(run, "assignments", nowMs);
      } catch (e) {
        // Old semantics: assignments are best-effort. After the retry budget
        // the sweep continues without them (getDriverTimeInputs' catch).
        const f = run.cursor?.failures;
        if (f && f.key === unitKey(run) && f.count + 1 >= MAX_UNIT_FAILURES) {
          return {
            phase,
            next: "plan_vehicles",
            unit: "assignments unavailable",
            cursor: { ...(run.cursor as SweepCursor), assignmentsFailed: true, assignDayIds: {}, failures: null },
          };
        }
        throw e;
      }
    case "plan_vehicles":
      return unitPlanVehicles(run);
    case "fetch_gps":
      return unitFetchGps(run, nowMs);
    case "detect":
      return unitDetect(run);
    case "finalize":
      return unitFinalize(run);
  }
}

export function unitKey(run: RunRow): string {
  return `${run.phase ?? "init"}:${describeCursor(run.phase, run.cursor)}`;
}

/* --------------------------------------------------------------- tick/lease */

const RUN_COLS =
  "id, status, phase, cursor, week_start, week_end, requested_week_start, refresh_hos, created_at, started_at, lease_until, steps, step_log, days_fetched";

/** Retire runs whose heartbeat (or start, for legacy rows) is older than 15 minutes. */
export async function failStalledRuns(now: Date = new Date()): Promise<{ failedIds: string[]; error?: string }> {
  const cutoff = iso(now.getTime() - STALL_MS);
  const { data, error } = await db()
    .from("driver_warehouse_runs")
    .select("id, phase, cursor, last_step, heartbeat_at, started_at")
    .eq("status", "running")
    .or(`heartbeat_at.lt.${cutoff},and(heartbeat_at.is.null,started_at.lt.${cutoff})`)
    .limit(100);
  if (error) return { failedIds: [], error: error.message };
  const failedIds: string[] = [];
  for (const r of data ?? []) {
    const msg = `Stalled: no progress for 15 minutes at phase ${r.phase ?? "legacy"}, cursor ${describeCursor(r.phase, r.cursor)}, last step ${r.last_step?.at ?? "none"}`;
    let q = db()
      .from("driver_warehouse_runs")
      .update({ status: "failed", error: msg, completed_at: now.toISOString(), lease_until: null })
      .eq("id", r.id)
      .eq("status", "running");
    q = r.heartbeat_at ? q.eq("heartbeat_at", r.heartbeat_at) : q.is("heartbeat_at", null);
    const { data: upd, error: e2 } = await q.select("id");
    if (e2) return { failedIds, error: e2.message };
    if (upd?.length) failedIds.push(String(r.id));
  }
  return { failedIds };
}

/** Oldest active run, claimed under a lease. null = nothing to do or another tick holds it. */
export async function claimNextRun(now: Date): Promise<RunRow | null> {
  const { data, error } = await db()
    .from("driver_warehouse_runs")
    .select("id")
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const target = data?.[0];
  if (!target) return null;
  const nowIso = now.toISOString();
  const { data: claimed, error: claimErr } = await db()
    .from("driver_warehouse_runs")
    .update({ status: "running", lease_until: iso(now.getTime() + LEASE_MS), heartbeat_at: nowIso })
    .eq("id", target.id)
    .in("status", ["queued", "running"])
    .or(`lease_until.is.null,lease_until.lt.${nowIso}`)
    .select(RUN_COLS);
  if (claimErr) throw new Error(claimErr.message);
  return (claimed?.[0] as RunRow) ?? null;
}

export type TickResult = {
  ok: boolean;
  runId: string | null;
  units: number;
  phase: string | null;
  status: string | null;
  stalled: string[];
  error?: string;
};

/**
 * One tick: watchdog, claim, then units until the budget is spent. A unit is
 * never started after `budgetMs`. Each unit's outcome is persisted with the
 * heartbeat in one UPDATE guarded by the lease we hold.
 */
export async function runDriverTimeTick(opts?: {
  now?: () => Date;
  budgetMs?: number;
  maxUnits?: number;
}): Promise<TickResult> {
  const clock = opts?.now ?? (() => new Date());
  const budget = opts?.budgetMs ?? TICK_BUDGET_MS;
  const t0 = clock().getTime();
  const wd = await failStalledRuns(clock());
  let run = await claimNextRun(clock());
  if (!run) return { ok: true, runId: null, units: 0, phase: null, status: null, stalled: wd.failedIds };
  let units = 0;
  while (clock().getTime() - t0 < budget && units < (opts?.maxUnits ?? Infinity)) {
    const started = clock().getTime();
    let result: UnitResult | null = null;
    let unitError: string | null = null;
    try {
      result = await runUnit(run, started);
    } catch (e: any) {
      unitError = e?.message ?? String(e);
    }
    units++;
    const persisted = await persistUnit(run, result, unitError, clock(), clock().getTime() - started);
    if (!persisted) return { ok: false, runId: run.id, units, phase: run.phase, status: run.status, stalled: wd.failedIds, error: "lease lost" };
    run = persisted;
    if (run.status !== "running" || unitError) break;
  }
  // Hand the lease back so the next tick (a minute later) can claim at once.
  // A tick that dies before this line leaves the lease to expire (90 s).
  if (run.status === "running" && run.lease_until) {
    await db()
      .from("driver_warehouse_runs")
      .update({ lease_until: null })
      .eq("id", run.id)
      .eq("lease_until", run.lease_until);
  }
  return { ok: true, runId: run.id, units, phase: run.phase, status: run.status, stalled: wd.failedIds };
}

/** Write one unit's outcome. Returns the updated run, or null if our lease was taken. */
export async function persistUnit(
  run: RunRow,
  result: UnitResult | null,
  unitError: string | null,
  now: Date,
  ms: number,
): Promise<RunRow | null> {
  const nowIso = now.toISOString();
  const key = unitKey(run);
  const step = {
    at: nowIso,
    phase: run.phase ?? "init",
    unit: result?.unit ?? key,
    rows: result?.rows ?? null,
    inserted: result?.inserted ?? null,
    ms,
    error: unitError,
  };
  const log = [...((run.step_log as unknown[]) ?? []), step].slice(-STEP_LOG_KEEP);
  const patch: Record<string, unknown> = {
    heartbeat_at: nowIso,
    lease_until: iso(now.getTime() + LEASE_MS),
    last_step: step,
    step_log: log,
    steps: (run.steps ?? 0) + 1,
  };
  if (unitError) {
    const prev = run.cursor?.failures;
    const count = prev && prev.key === key ? prev.count + 1 : 1;
    patch.cursor = { ...(run.cursor ?? {}), failures: { key, count, error: unitError } };
    if (count >= MAX_UNIT_FAILURES) {
      patch.status = "failed";
      patch.error = `Failed ${count} times at ${key}: ${unitError}`;
      patch.completed_at = nowIso;
      patch.lease_until = null;
    }
  } else if (result) {
    const cursor = { ...result.cursor, failures: null };
    patch.cursor = cursor;
    patch.phase = result.next === "completed" || result.next === "failed" ? run.phase ?? "init" : result.next;
    if (result.next === "completed") patch.phase = "completed";
    patch.days_fetched = (run.days_fetched ?? 0) + (result.daysFetched ?? 0);
    if (result.driversTotal != null) patch.drivers_total = result.driversTotal;
    if (result.windowStart) patch.window_start = result.windowStart;
    if (result.windowEnd) patch.window_end = result.windowEnd;
    if (cursor.counters) {
      patch.drivers_scanned = result.final?.driversScanned ?? cursor.detectIdx ?? 0;
      patch.events_found = result.final?.eventsFound ?? cursor.counters.eventsFound;
    }
    if (result.final) {
      patch.status = result.final.status;
      patch.error = result.final.error;
      patch.completed_at = nowIso;
      patch.lease_until = null;
      if (result.final.status === "failed") {
        patch.drivers_scanned = 0;
        patch.events_found = 0;
      }
    }
  }
  const { data, error } = await db()
    .from("driver_warehouse_runs")
    .update(patch)
    .eq("id", run.id)
    .eq("lease_until", run.lease_until)
    .select(RUN_COLS);
  if (error) throw new Error(error.message);
  return (data?.[0] as RunRow) ?? null;
}

/* ------------------------------------------------------------------ enqueue */

export async function enqueueDriverTimeSweep(opts: {
  now?: Date;
  triggeredBy?: string | null;
  weekStart?: string;
  refreshHos?: boolean;
}): Promise<{ runId: string; existing: boolean; weekStart: string; weekEnd: string }> {
  const now = opts.now ?? new Date();
  const { selectedWeekBounds } = await import("@/lib/driver-time.server");
  const { scheduledSweepWeek } = await import("@/lib/driver-time/week-label");
  const label = opts.weekStart ? selectedWeekBounds(opts.weekStart) : scheduledSweepWeek(now);
  let q = db().from("driver_warehouse_runs").select("id").in("status", ["queued", "running"]);
  q = opts.weekStart ? q.eq("requested_week_start", opts.weekStart) : q.is("requested_week_start", null).eq("week_start", label.weekStart);
  const { data: active, error: activeErr } = await q.limit(1);
  if (activeErr) throw new Error(activeErr.message);
  if (active?.[0]) return { runId: String(active[0].id), existing: true, ...label };
  const { data, error } = await db()
    .from("driver_warehouse_runs")
    .insert({
      week_start: label.weekStart,
      week_end: label.weekEnd,
      status: "queued",
      phase: "init",
      triggered_by: opts.triggeredBy ?? null,
      requested_week_start: opts.weekStart ?? null,
      refresh_hos: opts.refreshHos === true,
      cursor: { v: 1, nowMs: now.getTime() },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { runId: String(data.id), existing: false, ...label };
}

