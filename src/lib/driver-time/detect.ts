// Pure detection engine for driver non-driving time parked at a warehouse.
//
// Mirrors Joe's manual audit: for each driver, split the HOS duty segments on
// the ELD day boundary, keep the non-driving on-duty statuses, glue adjacent
// blocks together (including across a short movement gap inside the same
// geofence), locate each block, and flag the ones that sit at a warehouse
// longer than the threshold.
//
// No I/O here: everything is passed in so the rules are unit-testable.

import { matchGeofence, type Geofence, type LatLon } from "./geo";

export type DutyStatus =
  | "onDuty"
  | "driving"
  | "offDuty"
  | "sleeperBerth"
  | "yardMove"
  | "personalConveyance"
  | string;

export type HosSegment = {
  driverId: string;
  driverName?: string | null;
  status: DutyStatus;
  startMs: number;
  endMs: number;
  latitude?: number | null;
  longitude?: number | null;
  vehicleId?: string | null;
};

export type GpsSample = {
  vehicleId: string;
  timeMs: number;
  latitude: number;
  longitude: number;
};

export type DetectOptions = {
  /** Flag blocks at least this long. Default 90. */
  thresholdMinutes?: number;
  /** Merge two kept blocks separated by less than this much movement. Default 10. */
  mergeGapMinutes?: number;
  /** Hour (in the driver's local offset) at which the ELD day rolls over. Default 0. */
  eldDayStartHour?: number;
  /** Minutes offset from UTC for the driver's home terminal. Default -360 (CST). */
  tzOffsetMinutes?: number;
  /** Driver ids never reported on. */
  excludedDriverIds?: string[];
  /** Case-insensitive substrings; a driver name containing one is never reported. */
  excludedDriverNamePatterns?: string[];
  /** Max age of a GPS sample used as a location fallback. Default 30 minutes. */
  gpsFallbackToleranceMinutes?: number;
};

export type WarehouseEvent = {
  driverId: string;
  driverName: string | null;
  eventDate: string; // local YYYY-MM-DD
  startMs: number;
  endMs: number;
  durationMin: number;
  addressId: string | null;
  addressName: string | null;
  hub: string | null;
  statuses: string[];
  locationSource: "log" | "vehicle_gps" | "unknown";
  needsReview: boolean;
};

/** Duty statuses that count as "sitting at the warehouse". */
export const KEPT_STATUSES = new Set<DutyStatus>(["onDuty", "yardMove"]);

const MINUTE = 60_000;

export function isExcludedDriver(
  driver: { id: string; name?: string | null },
  opts: DetectOptions,
): boolean {
  const ids = (opts.excludedDriverIds ?? []).map(String);
  if (ids.includes(String(driver.id))) return true;
  const name = (driver.name ?? "").toLowerCase();
  if (!name) return false;
  return (opts.excludedDriverNamePatterns ?? []).some(
    (p) => p.trim().length > 0 && name.includes(p.trim().toLowerCase()),
  );
}

/** Local (offset-shifted) YYYY-MM-DD for an instant. */
export function localDateKey(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * MINUTE).toISOString().slice(0, 10);
}

/**
 * ELD day boundaries (as epoch ms) strictly inside (startMs, endMs).
 * A boundary is the moment local time hits `hour`.
 */
export function eldDayBoundaries(
  startMs: number,
  endMs: number,
  hour: number,
  tzOffsetMinutes: number,
): number[] {
  const out: number[] = [];
  const shift = tzOffsetMinutes * MINUTE;
  // first boundary at or before startMs
  const localStart = new Date(startMs + shift);
  const dayStartLocal = Date.UTC(
    localStart.getUTCFullYear(),
    localStart.getUTCMonth(),
    localStart.getUTCDate(),
    hour,
  );
  let b = dayStartLocal - shift;
  if (b > startMs) b -= 86_400_000;
  while (b <= endMs) {
    if (b > startMs && b < endMs) out.push(b);
    b += 86_400_000;
  }
  return out;
}

function splitOnEldDay(seg: HosSegment, opts: Required<Pick<DetectOptions, "eldDayStartHour" | "tzOffsetMinutes">>): HosSegment[] {
  const bounds = eldDayBoundaries(seg.startMs, seg.endMs, opts.eldDayStartHour, opts.tzOffsetMinutes);
  if (!bounds.length) return [seg];
  const parts: HosSegment[] = [];
  let cursor = seg.startMs;
  for (const b of bounds) {
    parts.push({ ...seg, startMs: cursor, endMs: b });
    // only the first part keeps the recorded start location
    cursor = b;
  }
  parts.push({ ...seg, startMs: cursor, endMs: seg.endMs, latitude: null, longitude: null });
  return parts;
}

type Block = {
  startMs: number;
  endMs: number;
  statuses: string[];
  segments: HosSegment[];
};

function resolveLocation(
  block: Block,
  gps: GpsSample[],
  toleranceMs: number,
): { point: LatLon | null; source: "log" | "vehicle_gps" | "unknown" } {
  for (const s of block.segments) {
    if (typeof s.latitude === "number" && typeof s.longitude === "number") {
      return { point: { latitude: s.latitude, longitude: s.longitude }, source: "log" };
    }
  }
  const vehicleIds = new Set(block.segments.map((s) => s.vehicleId).filter(Boolean) as string[]);
  let best: { sample: GpsSample; delta: number } | null = null;
  for (const sample of gps) {
    if (vehicleIds.size && !vehicleIds.has(sample.vehicleId)) continue;
    const delta = Math.abs(sample.timeMs - block.startMs);
    if (delta > toleranceMs) continue;
    if (!best || delta < best.delta) best = { sample, delta };
  }
  if (best) {
    return {
      point: { latitude: best.sample.latitude, longitude: best.sample.longitude },
      source: "vehicle_gps",
    };
  }
  return { point: null, source: "unknown" };
}

/**
 * Build flagged warehouse events for one driver.
 * `segments` may be unsorted and may span more than the reported week.
 */
export function detectWarehouseEvents(input: {
  driver: { id: string; name?: string | null };
  segments: HosSegment[];
  warehouses: Geofence[];
  gpsSamples?: GpsSample[];
  options?: DetectOptions;
}): WarehouseEvent[] {
  const opts = input.options ?? {};
  const thresholdMinutes = opts.thresholdMinutes ?? 90;
  const mergeGapMinutes = opts.mergeGapMinutes ?? 10;
  const eldDayStartHour = opts.eldDayStartHour ?? 0;
  const tzOffsetMinutes = opts.tzOffsetMinutes ?? -360;
  const gpsTolerance = (opts.gpsFallbackToleranceMinutes ?? 30) * MINUTE;

  if (isExcludedDriver(input.driver, opts)) return [];

  const segs = input.segments
    .filter((s) => String(s.driverId) === String(input.driver.id))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((s) => splitOnEldDay(s, { eldDayStartHour, tzOffsetMinutes }));

  // 1. build raw blocks from contiguous kept segments
  const blocks: Block[] = [];
  const gaps: Array<{ afterBlock: number; durationMs: number }> = [];
  let current: Block | null = null;
  let pendingGapMs = 0;

  for (const s of segs) {
    const kept = KEPT_STATUSES.has(s.status);
    if (kept) {
      const sameEldDay =
        current && localDateKey(current.startMs, tzOffsetMinutes) === localDateKey(s.startMs, tzOffsetMinutes);
      if (current && sameEldDay && s.startMs - current.endMs <= MINUTE && pendingGapMs === 0) {
        current.endMs = s.endMs;
        current.segments.push(s);
        if (!current.statuses.includes(s.status)) current.statuses.push(s.status);
      } else {
        if (current) {
          blocks.push(current);
          if (pendingGapMs > 0) gaps.push({ afterBlock: blocks.length - 1, durationMs: pendingGapMs });
        }
        current = { startMs: s.startMs, endMs: s.endMs, statuses: [s.status], segments: [s] };
      }
      pendingGapMs = 0;
    } else if (current) {
      pendingGapMs += s.endMs - s.startMs;
    }
  }
  if (current) blocks.push(current);

  // 2. locate every block
  const gpsSamples = input.gpsSamples ?? [];
  const located = blocks.map((b) => {
    const { point, source } = resolveLocation(b, gpsSamples, gpsTolerance);
    const fence = matchGeofence(point, input.warehouses);
    return { block: b, point, source, fence };
  });

  // 3. merge adjacent blocks separated by a short movement gap inside the same fence
  const merged: typeof located = [];
  for (const item of located) {
    const prev = merged[merged.length - 1];
    const gap = prev ? item.block.startMs - prev.block.endMs : Infinity;
    const sameFence = prev && prev.fence && item.fence && prev.fence.id === item.fence.id;
    const sameEldDay =
      prev &&
      localDateKey(prev.block.startMs, tzOffsetMinutes) === localDateKey(item.block.startMs, tzOffsetMinutes);
    if (prev && sameFence && sameEldDay && gap < mergeGapMinutes * MINUTE) {
      prev.block.endMs = item.block.endMs;
      prev.block.segments.push(...item.block.segments);
      for (const st of item.block.statuses) if (!prev.block.statuses.includes(st)) prev.block.statuses.push(st);
      continue;
    }
    merged.push({ ...item, block: { ...item.block, segments: [...item.block.segments], statuses: [...item.block.statuses] } });
  }

  // 4. threshold + geofence filter
  const events: WarehouseEvent[] = [];
  for (const item of merged) {
    const durationMin = Math.round((item.block.endMs - item.block.startMs) / MINUTE);
    if (durationMin < thresholdMinutes) continue;
    const unknown = item.source === "unknown";
    if (!unknown && !item.fence) continue; // located, but not at a warehouse
    events.push({
      driverId: String(input.driver.id),
      driverName: input.driver.name ?? input.segments[0]?.driverName ?? null,
      eventDate: localDateKey(item.block.startMs, tzOffsetMinutes),
      startMs: item.block.startMs,
      endMs: item.block.endMs,
      durationMin,
      addressId: item.fence?.id ?? null,
      addressName: item.fence?.name ?? null,
      hub: item.fence?.hub ?? null,
      statuses: item.block.statuses,
      locationSource: item.source,
      needsReview: unknown,
    });
  }
  return events.sort((a, b) => a.startMs - b.startMs);
}
