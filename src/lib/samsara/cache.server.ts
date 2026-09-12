// Reusable Samsara data layer (server-only).
//
// Every Samsara read the Driver Time module needs — HOS logs, HOS daily logs,
// driver-vehicle assignments and vehicle GPS — goes through here. Results are
// cached per Central calendar day in samsara_cache_days / samsara_cache_rows,
// so a rescan, a diagnostics run and an ad-hoc probe over the same days share
// one fetch instead of hammering the org's 5 req/s budget three times over.
//
// Cache semantics: a closed day fetched after it closed is permanent; a day
// that was still in progress when fetched goes stale after 30 minutes. Pass
// `refresh: true` to force a re-fetch of every day in the window.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  fetchHosLogs,
  fetchDailyLogs,
  fetchDriverVehicleAssignments,
  fetchVehicleGpsHistory,
  type NormalizedHosSegment,
  type SamsaraDailyLog,
  type SamsaraAssignment,
} from "@/lib/samsara/hos.server";
import {
  backfillSegmentVehicles,
  centralDaysCovering,
  coversEntities,
  isCacheDayFresh,
  type AssignmentRow,
  type CacheDay,
} from "@/lib/samsara/cache-window";

const db = () => supabaseAdmin as any;

export type Dataset = "hos_logs" | "daily_logs" | "assignments" | "gps";

export type GpsSample = { vehicleId: string; timeMs: number; latitude: number; longitude: number };

export type CacheStat = { dataset: Dataset; days: number; cachedDays: number; fetchedDays: number; rows: number };

type Window = { startMs: number; endMs: number; refresh?: boolean };

function iso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Days in the window that still need a fetch, plus the rows already cached. */
async function readCache(
  dataset: Dataset,
  days: CacheDay[],
  refresh: boolean,
  nowMs: number,
  entityIds: string[],
) {
  if (refresh) return { staleDays: days, rows: [] as any[] };
  const dates = days.map((d) => d.date);
  const { data: dayRows, error } = await db()
    .from("samsara_cache_days")
    .select("id, day_date, fetched_at, complete, coverage")
    .eq("dataset", dataset)
    .in("day_date", dates);
  if (error) throw new Error(`Samsara cache read failed (${dataset} days): ${error.message}`);

  const fresh = new Map<string, string>(); // day_date -> day_id
  for (const row of dayRows ?? []) {
    if (isCacheDayFresh(row, nowMs) && coversEntities(row.coverage, entityIds)) fresh.set(row.day_date, row.id);
  }

  const staleDays = days.filter((d) => !fresh.has(d.date));
  if (!fresh.size) return { staleDays, rows: [] as any[] };

  const rows: any[] = [];
  const ids = [...fresh.values()];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error: rowsError } = await db()
      .from("samsara_cache_rows")
      .select("payload")
      .in("day_id", ids)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (rowsError) throw new Error(`Samsara cache read failed (${dataset} rows): ${rowsError.message}`);
    rows.push(...(data ?? []).map((r: any) => r.payload));
    if ((data?.length ?? 0) < pageSize) break;
  }
  return { staleDays, rows };
}

/** Replace one day's cached rows atomically enough for a cache: delete, then insert. */
async function writeCacheDay(
  dataset: Dataset,
  day: CacheDay,
  entries: Array<{ entityKind: string; entityId: string; startMs: number | null; endMs: number | null; payload: unknown }>,
  complete: boolean,
  error: string | null,
  coverage: string[],
) {
  const { data: dayRow, error: upsertError } = await db()
    .from("samsara_cache_days")
    .upsert(
      {
        dataset,
        day_date: day.date,
        window_start: new Date(day.startMs).toISOString(),
        window_end: new Date(day.endMs).toISOString(),
        fetched_at: new Date().toISOString(),
        complete,
        row_count: entries.length,
        error,
        coverage,
      },
      { onConflict: "dataset,day_date" },
    )
    .select("id")
    .single();
  if (upsertError) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${upsertError.message}`);
  const dayId = dayRow.id as string;

  const { error: deleteError } = await db().from("samsara_cache_rows").delete().eq("day_id", dayId);
  if (deleteError) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${deleteError.message}`);

  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500).map((e) => ({
      day_id: dayId,
      dataset,
      day_date: day.date,
      entity_kind: e.entityKind,
      entity_id: e.entityId,
      start_ts: iso(e.startMs),
      end_ts: iso(e.endMs),
      payload: e.payload,
    }));
    const { error: insertError } = await db().from("samsara_cache_rows").insert(chunk);
    if (insertError) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${insertError.message}`);
  }
  return dayId;
}

/**
 * Core loop shared by every dataset: work out the Central days the window
 * covers, serve the fresh ones from the cache, fetch and store the rest.
 */
async function loadDataset<T>(args: {
  dataset: Dataset;
  window: Window;
  fetchDay: (day: CacheDay) => Promise<T[]>;
  describe: (row: T) => { entityKind: string; entityId: string; startMs: number | null; endMs: number | null };
  /** Keep only the rows that actually fall inside the caller's window. */
  inWindow: (row: T, startMs: number, endMs: number) => boolean;
  /** Drivers or vehicles this call asks about; a cached day must cover them all. */
  entityIds: string[];
}): Promise<{ rows: T[]; stat: CacheStat }> {
  const nowMs = Date.now();
  const endMs = Math.min(args.window.endMs, nowMs);
  const startMs = args.window.startMs;
  if (!(endMs > startMs)) {
    return { rows: [], stat: { dataset: args.dataset, days: 0, cachedDays: 0, fetchedDays: 0, rows: 0 } };
  }
  const days = centralDaysCovering(startMs, endMs);
  const { staleDays, rows: cached } = await readCache(
    args.dataset,
    days,
    args.window.refresh === true,
    nowMs,
    args.entityIds,
  );

  const fetched: T[] = [];
  for (const day of staleDays) {
    const dayEnd = Math.min(day.endMs, nowMs);
    if (!(dayEnd > day.startMs)) continue;
    const rows = await args.fetchDay({ ...day, endMs: dayEnd });
    fetched.push(...rows);
    await writeCacheDay(
      args.dataset,
      day,
      rows.map((row) => ({ ...args.describe(row), payload: row })),
      // A day is only "complete" once it is over; today's rows will grow.
      day.endMs <= nowMs,
      null,
      args.entityIds,
    );
  }

  const all = [...(cached as T[]), ...fetched].filter((row) => args.inWindow(row, startMs, endMs));
  return {
    rows: all,
    stat: {
      dataset: args.dataset,
      days: days.length,
      cachedDays: days.length - staleDays.length,
      fetchedDays: staleDays.length,
      rows: all.length,
    },
  };
}

/* --------------------------------------------------------------- public API */

export async function getHosSegments(
  opts: Window & { driverIds: string[] },
): Promise<{ segments: NormalizedHosSegment[]; stat: CacheStat }> {
  const ids = new Set(opts.driverIds);
  const { rows, stat } = await loadDataset<NormalizedHosSegment>({
    dataset: "hos_logs",
    window: opts,
    entityIds: opts.driverIds,
    fetchDay: (day) => fetchHosLogs({ startMs: day.startMs, endMs: day.endMs, driverIds: opts.driverIds }),
    describe: (s) => ({ entityKind: "driver", entityId: s.driverId, startMs: s.startMs, endMs: s.endMs }),
    inWindow: (s, startMs, endMs) => s.endMs > startMs && s.startMs < endMs,
  });
  // Cached days may hold drivers the current roster excludes.
  return { segments: rows.filter((s) => ids.has(s.driverId)), stat };
}

export async function getDailyLogs(
  opts: Window & { driverIds: string[] },
): Promise<{ dailyLogs: SamsaraDailyLog[]; stat: CacheStat }> {
  const ids = new Set(opts.driverIds);
  const { rows, stat } = await loadDataset<SamsaraDailyLog>({
    dataset: "daily_logs",
    window: opts,
    entityIds: opts.driverIds,
    fetchDay: (day) => fetchDailyLogs({ startMs: day.startMs, endMs: day.endMs, driverIds: opts.driverIds }),
    describe: (d) => ({ entityKind: "driver", entityId: d.driverId, startMs: d.startMs, endMs: d.endMs }),
    inWindow: () => true,
  });
  return { dailyLogs: rows.filter((d) => ids.has(d.driverId)), stat };
}

export async function getAssignments(
  opts: Window & { driverIds: string[] },
): Promise<{ assignments: SamsaraAssignment[]; stat: CacheStat }> {
  const ids = new Set(opts.driverIds);
  const { rows, stat } = await loadDataset<SamsaraAssignment>({
    dataset: "assignments",
    window: opts,
    entityIds: opts.driverIds,
    fetchDay: (day) =>
      fetchDriverVehicleAssignments({ startMs: day.startMs, endMs: day.endMs, driverIds: opts.driverIds }),
    describe: (a) => ({ entityKind: "driver", entityId: a.driverId, startMs: a.startMs, endMs: a.endMs }),
    inWindow: (a, startMs, endMs) => (a.endMs ?? Number.MAX_SAFE_INTEGER) > startMs && a.startMs < endMs,
  });
  return { assignments: rows.filter((a) => ids.has(a.driverId)), stat };
}

export async function getVehicleGps(
  opts: Window & { vehicleIds: string[] },
): Promise<{ samples: GpsSample[]; stat: CacheStat }> {
  if (!opts.vehicleIds.length) {
    return { samples: [], stat: { dataset: "gps", days: 0, cachedDays: 0, fetchedDays: 0, rows: 0 } };
  }
  const ids = new Set(opts.vehicleIds);
  const { rows, stat } = await loadDataset<GpsSample>({
    dataset: "gps",
    window: opts,
    entityIds: opts.vehicleIds,
    fetchDay: (day) => fetchVehicleGpsHistory({ startMs: day.startMs, endMs: day.endMs, vehicleIds: opts.vehicleIds }),
    describe: (g) => ({ entityKind: "vehicle", entityId: g.vehicleId, startMs: g.timeMs, endMs: g.timeMs }),
    inWindow: (g, startMs, endMs) => g.timeMs >= startMs && g.timeMs < endMs,
  });
  return { samples: rows.filter((g) => ids.has(g.vehicleId)), stat };
}

/**
 * One call for the whole detection input set: segments with missing vehicles
 * backfilled from assignments, plus the GPS those vehicles reported.
 */
export async function getDriverTimeInputs(opts: Window & { driverIds: string[] }): Promise<{
  segments: NormalizedHosSegment[];
  assignments: SamsaraAssignment[];
  gpsSamples: GpsSample[];
  vehiclesFilled: number;
  vehiclesFilledFromDay: number;
  driverDayVehicles: number;
  stats: CacheStat[];
}> {
  const { segments, stat: hosStat } = await getHosSegments(opts);
  const { assignments, stat: assignStat } = await getAssignments(opts).catch(() => ({
    assignments: [] as SamsaraAssignment[],
    stat: { dataset: "assignments" as Dataset, days: 0, cachedDays: 0, fetchedDays: 0, rows: 0 },
  }));

  const assignmentRows: AssignmentRow[] = assignments.map((a) => ({
    driverId: a.driverId,
    vehicleId: a.vehicleId,
    startMs: a.startMs,
    endMs: a.endMs,
  }));
  // One vehicle per driver-day first, so a block Samsara left blank still gets
  // the truck the driver actually worked out of that day — that is the GPS the
  // fence-exit trim rule reads.
  const dayVehicles = dominantVehiclePerDriverDay(assignmentRows);
  const { segments: filledSegments, filled, filledFromDay } = backfillSegmentVehicles(
    segments,
    assignmentRows,
    dayVehicles,
  );

  // GPS for every vehicle the day mapping names, not just the ones that ended
  // up stamped on a segment: trimming a block needs the vehicle's track across
  // the whole day, including after the log stopped mentioning it.
  const vehicleIds = Array.from(
    new Set(
      [...filledSegments.map((s) => s.vehicleId), ...dayVehicles.values()].filter(
        (v): v is string => Boolean(v) && v !== "0",
      ),
    ),
  );
  const { samples, stat: gpsStat } = await getVehicleGps({ ...opts, vehicleIds });

  return {
    segments: filledSegments,
    assignments,
    gpsSamples: samples,
    vehiclesFilled: filled,
    vehiclesFilledFromDay: filledFromDay,
    driverDayVehicles: dayVehicles.size,
    stats: [hosStat, assignStat, gpsStat],
  };
}
