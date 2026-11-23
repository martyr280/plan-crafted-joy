// Reusable Samsara data layer (server-only).
//
// Every Samsara read the Driver Time module needs — HOS logs, HOS daily logs,
// driver-vehicle assignments and vehicle GPS — goes through here. Results are
// cached per Central calendar day in samsara_cache_days / samsara_cache_rows,
// so a rescan, a diagnostics run and an ad-hoc probe over the same days share
// one fetch instead of hammering the org's 5 req/s budget three times over.
//
// Cache semantics: a closed day fetched after it closed is permanent; a day
// that was still in progress when fetched goes stale after 30 minutes, and so
// does any day whose stored rows don't add up to row_count. Pass
// `refresh: true` to force a re-fetch of every day in the window. GPS rows are
// append-only (never deleted); other datasets use a staged, kill-safe replace.

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
  dominantVehiclePerDriverDay,
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
    .select("id, day_date, fetched_at, complete, coverage, row_count")
    .eq("dataset", dataset)
    .in("day_date", dates);
  if (error) throw new Error(`Samsara cache read failed (${dataset} days): ${error.message}`);

  const fresh = new Map<string, string>(); // day_date -> day_id
  for (const row of dayRows ?? []) {
    if (!isCacheDayFresh(row, nowMs) || !coversEntities(row.coverage, entityIds)) continue;
    // A day whose stored rows don't add up to its row_count was cut off mid-write
    // (pre-2026-11-23 writer marked the day complete before inserting): stale.
    if (!(await cacheDayRowsMatch(row.id, row.row_count))) continue;
    fresh.set(row.day_date, row.id);
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

/** Does the day hold exactly row_count rows? */
export async function cacheDayRowsMatch(dayId: string, rowCount: number | null | undefined): Promise<boolean> {
  const { count, error } = await db()
    .from("samsara_cache_rows")
    .select("id", { count: "exact", head: true })
    .eq("day_id", dayId);
  if (error) throw new Error(`Samsara cache count failed: ${error.message}`);
  return typeof count === "number" && count === Number(rowCount ?? 0);
}

type CacheEntry = { entityKind: string; entityId: string; startMs: number | null; endMs: number | null; payload: unknown };

function toRow(dataset: Dataset, day: CacheDay, dayId: string, e: CacheEntry) {
  return {
    day_id: dayId,
    dataset,
    day_date: day.date,
    entity_kind: e.entityKind,
    entity_id: e.entityId,
    start_ts: iso(e.startMs),
    end_ts: iso(e.endMs),
    payload: e.payload,
  };
}

/**
 * Kill-safe replace of one NON-GPS day (hos_logs, daily_logs, assignments):
 *   1. mark the day complete=false, coverage=[]  (nobody can read it as fresh)
 *   2. delete that day's rows                     (approved 2026-11-23, non-GPS only)
 *   3. insert in chunks of 500
 *   4. flip complete / coverage / row_count / fetched_at
 * A kill anywhere before 4 leaves a day that covers no entity, so it is re-fetched.
 * GPS never comes through here: see appendGpsChunk.
 */
export async function writeCacheDay(
  dataset: Dataset,
  day: CacheDay,
  entries: CacheEntry[],
  complete: boolean,
  error: string | null,
  coverage: string[],
) {
  if (dataset === "gps") throw new Error("GPS cache days are append-only; use appendGpsChunk.");
  const dayId = await beginCacheDay(dataset, day);
  const { error: deleteError } = await db().from("samsara_cache_rows").delete().eq("day_id", dayId);
  if (deleteError) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${deleteError.message}`);
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500).map((e) => toRow(dataset, day, dayId, e));
    const { error: insertError } = await db().from("samsara_cache_rows").insert(chunk);
    if (insertError) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${insertError.message}`);
  }
  await finishCacheDay(dataset, day, dayId, { complete, error, coverage, rowCount: entries.length });
  return dayId;
}

/** Step 1 of a staged write: the day exists and reads as stale. Returns its id. */
export async function beginCacheDay(dataset: Dataset, day: CacheDay): Promise<string> {
  const { data, error } = await db()
    .from("samsara_cache_days")
    .upsert(
      {
        dataset,
        day_date: day.date,
        window_start: new Date(day.startMs).toISOString(),
        window_end: new Date(day.endMs).toISOString(),
        fetched_at: new Date().toISOString(),
        complete: false,
        coverage: [],
        error: null,
      },
      { onConflict: "dataset,day_date" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${error.message}`);
  return data.id as string;
}

/** Last step of a staged write: the day becomes readable. */
export async function finishCacheDay(
  dataset: Dataset,
  day: CacheDay,
  dayId: string,
  v: { complete: boolean; error: string | null; coverage: string[]; rowCount: number },
) {
  const { error } = await db()
    .from("samsara_cache_days")
    .update({
      fetched_at: new Date().toISOString(),
      complete: v.complete,
      row_count: v.rowCount,
      error: v.error,
      coverage: v.coverage,
    })
    .eq("id", dayId);
  if (error) throw new Error(`Samsara cache write failed (${dataset} ${day.date}): ${error.message}`);
}

const gpsKey = (vehicleId: string, timeMs: number, lat: number, lon: number) => `${vehicleId}|${timeMs}|${lat}|${lon}`;

/**
 * Append-only GPS fill for one day and a chunk of vehicles. Reads what is
 * already stored for those vehicles on that day and inserts only the samples
 * still missing (multiset diff, so Samsara's own duplicate samples survive
 * exactly as a fresh write would store them). Never deletes. A retry after a
 * kill inserts only what the killed attempt didn't.
 */
export async function appendGpsChunk(
  day: CacheDay,
  dayId: string,
  vehicleIds: string[],
  samples: GpsSample[],
): Promise<{ inserted: number; existing: number }> {
  const have = new Map<string, number>();
  let existing = 0;
  let after: string | null = null;
  for (let guard = 0; guard < 2000; guard++) {
    let q = db()
      .from("samsara_cache_rows")
      .select("id, payload")
      .eq("day_id", dayId)
      .in("entity_id", vehicleIds)
      .order("id", { ascending: true })
      .limit(1000);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) throw new Error(`Samsara cache read failed (gps ${day.date}): ${error.message}`);
    for (const r of data ?? []) {
      const p = r.payload as GpsSample;
      const k = gpsKey(String(p.vehicleId), p.timeMs, p.latitude, p.longitude);
      have.set(k, (have.get(k) ?? 0) + 1);
      existing++;
    }
    if ((data?.length ?? 0) < 1000) break;
    after = data[data.length - 1].id;
  }
  const missing: GpsSample[] = [];
  for (const g of samples) {
    const k = gpsKey(String(g.vehicleId), g.timeMs, g.latitude, g.longitude);
    const n = have.get(k) ?? 0;
    if (n > 0) have.set(k, n - 1);
    else missing.push(g);
  }
  for (let i = 0; i < missing.length; i += 1000) {
    const chunk = missing.slice(i, i + 1000).map((g) =>
      toRow("gps", day, dayId, { entityKind: "vehicle", entityId: g.vehicleId, startMs: g.timeMs, endMs: g.timeMs, payload: g }),
    );
    const { error } = await db().from("samsara_cache_rows").insert(chunk);
    if (error) throw new Error(`Samsara cache write failed (gps ${day.date}): ${error.message}`);
  }
  return { inserted: missing.length, existing };
}

/** Exact stored row count for a day (used to close a GPS day after its last chunk). */
export async function countCacheDayRows(dayId: string): Promise<number> {
  const { count, error } = await db()
    .from("samsara_cache_rows")
    .select("id", { count: "exact", head: true })
    .eq("day_id", dayId);
  if (error || typeof count !== "number") throw new Error(`Samsara cache count failed: ${error?.message ?? "no count"}`);
  return count;
}

/**
 * Keyset read of one entity's cached payloads across a fixed set of days, on
 * the (dataset, entity_id, start_ts, id) index. No OFFSET. Returned in id order,
 * which is the order the old whole-window read (order by id) produced, so
 * detection's array-order tie-breaks are unchanged.
 */
export async function readEntityRows<T>(dataset: Dataset, entityId: string, dayIds: string[]): Promise<T[]> {
  if (!dayIds.length) return [];
  const out: Array<{ id: string; payload: T }> = [];
  let last: { ts: string; id: string } | null = null;
  for (let guard = 0; guard < 5000; guard++) {
    let q = db()
      .from("samsara_cache_rows")
      .select("id, start_ts, payload")
      .eq("dataset", dataset)
      .eq("entity_id", entityId)
      .in("day_id", dayIds)
      .order("start_ts", { ascending: true })
      .order("id", { ascending: true })
      .limit(1000);
    if (last) q = q.or(`start_ts.gt."${last.ts}",and(start_ts.eq."${last.ts}",id.gt.${last.id})`);
    const { data, error } = await q;
    if (error) throw new Error(`Samsara cache read failed (${dataset} ${entityId}): ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; start_ts: string; payload: T }>;
    out.push(...rows.map((r) => ({ id: r.id, payload: r.payload })));
    if (rows.length < 1000) break;
    const tail = rows[rows.length - 1];
    last = { ts: tail.start_ts, id: tail.id };
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.map((r) => r.payload);
}

/** Fresh, covering, fully-written cache days for a window: date -> day id. */
export async function freshCacheDays(
  dataset: Dataset,
  days: CacheDay[],
  entityIds: string[],
  nowMs: number,
): Promise<Map<string, string>> {
  const { data, error } = await db()
    .from("samsara_cache_days")
    .select("id, day_date, fetched_at, complete, coverage, row_count")
    .eq("dataset", dataset)
    .in("day_date", days.map((d) => d.date));
  if (error) throw new Error(`Samsara cache read failed (${dataset} days): ${error.message}`);
  const out = new Map<string, string>();
  for (const row of data ?? []) {
    if (!isCacheDayFresh(row, nowMs) || !coversEntities(row.coverage, entityIds)) continue;
    if (!(await cacheDayRowsMatch(row.id, row.row_count))) continue;
    out.set(row.day_date, row.id);
  }
  return out;
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
    if (args.dataset === "gps") {
      const dayId = await beginCacheDay("gps", day);
      await appendGpsChunk(day, dayId, args.entityIds, rows as unknown as GpsSample[]);
      await finishCacheDay("gps", day, dayId, {
        complete: day.endMs <= nowMs,
        error: null,
        coverage: args.entityIds,
        rowCount: await countCacheDayRows(dayId),
      });
      continue;
    }
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
export async function getDriverTimeInputs(opts: Window & { driverIds: string[]; refreshHos?: boolean }): Promise<{
  segments: NormalizedHosSegment[];
  assignments: SamsaraAssignment[];
  gpsSamples: GpsSample[];
  vehiclesFilled: number;
  vehiclesFilledFromDay: number;
  driverDayVehicles: number;
  stats: CacheStat[];
}> {
  // refreshHos: re-pull only the HOS logs (e.g. days cached before `remark` was kept).
  const { segments, stat: hosStat } = await getHosSegments({ ...opts, refresh: opts.refresh || opts.refreshHos });
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
