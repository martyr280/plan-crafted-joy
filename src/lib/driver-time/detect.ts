// Pure detection engine for driver non-driving time parked at a warehouse.
//
// Mirrors Joe's manual audit: for each driver, split the HOS duty segments on
// the ELD day boundary, keep the non-driving on-duty statuses, glue adjacent
// blocks together (including across a short movement gap inside the same
// geofence), locate each block, and flag the ones that sit at a warehouse
// longer than the threshold.
//
// No I/O here: everything is passed in so the rules are unit-testable.

import { matchGeofence, usableCoordinates, type Geofence, type LatLon } from "./geo";

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
  /** Flag blocks strictly longer than this duration. Default 90. */
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
  /**
   * "presence" (default): any HOS status inside the warehouse fence is
   * warehouse time, bounded by the driver's working day.
   * "onduty": the legacy on-duty/yard-move-only rule.
   */
  basis?: "presence" | "onduty";
  /** The driver's Samsara tags, used to attribute vehicle-less on-duty time to a home hub. */
  hubTags?: string[];
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
  locationSource: "log" | "vehicle_gps" | "assumed_hub" | "unknown";
  needsReview: boolean;
};

/** Duty statuses that count as "sitting at the warehouse" under the legacy basis. */
export const KEPT_STATUSES = new Set<DutyStatus>(["onDuty", "yardMove"]);

/** Statuses that do not open the driver's working day. */
const REST_STATUSES = new Set<DutyStatus>(["offDuty", "sleeperBerth"]);


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
    parts.push({ ...seg, startMs: cursor, endMs: b, ...(cursor === seg.startMs ? {} : { latitude: null, longitude: null }) });
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
    if (usableCoordinates(s.latitude, s.longitude)) {
      return { point: { latitude: s.latitude!, longitude: s.longitude! }, source: "log" };
    }
  }
  const vehicleIds = new Set(block.segments.map((s) => s.vehicleId).filter(Boolean) as string[]);
  if (vehicleIds.size !== 1) return { point: null, source: "unknown" };
  let best: { sample: GpsSample; delta: number } | null = null;
  for (const sample of gps) {
    if (!vehicleIds.has(sample.vehicleId) || !usableCoordinates(sample.latitude, sample.longitude)) continue;
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

export type DetectInput = {
  driver: { id: string; name?: string | null };
  segments: HosSegment[];
  warehouses: Geofence[];
  gpsSamples?: GpsSample[];
  options?: DetectOptions;
};

/**
 * Build flagged warehouse events for one driver.
 * `segments` may be unsorted and may span more than the reported week.
 */
export function detectWarehouseEvents(input: DetectInput): WarehouseEvent[] {
  return (input.options?.basis ?? "presence") === "onduty"
    ? detectOnDutyEvents(input)
    : detectPresenceEvents(input);
}

/** Legacy basis: only on-duty / yard-move segments can form a block. */
export function detectOnDutyEvents(input: DetectInput): WarehouseEvent[] {

  const opts = input.options ?? {};
  const thresholdMinutes = opts.thresholdMinutes ?? 90;
  const mergeGapMinutes = opts.mergeGapMinutes ?? 10;
  const eldDayStartHour = opts.eldDayStartHour ?? 0;
  const tzOffsetMinutes = opts.tzOffsetMinutes ?? -360;
  const gpsTolerance = (opts.gpsFallbackToleranceMinutes ?? 30) * MINUTE;
  const eldKey = (ms: number) => localDateKey(ms - eldDayStartHour * 60 * MINUTE, tzOffsetMinutes);

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
        current && eldKey(current.startMs) === eldKey(s.startMs);
      if (current && sameEldDay && s.startMs - current.endMs <= MINUTE && pendingGapMs === 0) {
        current.endMs = Math.max(current.endMs, s.endMs);
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
      eldKey(prev.block.startMs) === eldKey(item.block.startMs);
    const gapSegments = prev ? segs.filter(s => s.startMs < item.block.startMs && s.endMs > prev.block.endMs) : [];
    const movementOnly = gap === 0 || (gapSegments.length > 0 && gapSegments.every(s => s.status === "driving" || s.status === "yardMove"));
    if (prev && sameFence && sameEldDay && gap >= 0 && gap < mergeGapMinutes * MINUTE && movementOnly) {
      prev.block.endMs = Math.max(prev.block.endMs, item.block.endMs);
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
    if ((item.block.endMs - item.block.startMs) <= thresholdMinutes * MINUTE) continue;
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

/* ------------------------------------------------------------- presence basis */

type LocatedSeg = {
  seg: HosSegment;
  point: LatLon | null;
  source: "log" | "vehicle_gps" | "unknown";
};

function hasVehicle(seg: HosSegment): boolean {
  const v = String(seg.vehicleId ?? "").trim();
  return v !== "" && v !== "0";
}

/** Locate a single segment: log coordinates, then the nearest vehicle GPS sample. */
function locateSegment(seg: HosSegment, gps: GpsSample[], toleranceMs: number): LocatedSeg {
  if (usableCoordinates(seg.latitude, seg.longitude)) {
    return { seg, point: { latitude: seg.latitude!, longitude: seg.longitude! }, source: "log" };
  }
  if (hasVehicle(seg)) {
    const vehicleId = String(seg.vehicleId);
    let best: { sample: GpsSample; delta: number } | null = null;
    for (const sample of gps) {
      if (String(sample.vehicleId) !== vehicleId) continue;
      if (!usableCoordinates(sample.latitude, sample.longitude)) continue;
      const delta = Math.abs(sample.timeMs - seg.startMs);
      if (delta > toleranceMs) continue;
      if (!best || delta < best.delta) best = { sample, delta };
    }
    if (best) {
      return {
        seg,
        point: { latitude: best.sample.latitude, longitude: best.sample.longitude },
        source: "vehicle_gps",
      };
    }
  }
  return { seg, point: null, source: "unknown" };
}

/** The single selected fence named by one of the driver's tags, if unambiguous. */
export function hubFenceFromTags(tags: string[] | undefined, fences: Geofence[]): Geofence | null {
  const t = (tags ?? []).map((x) => String(x ?? "").trim().toLowerCase()).filter(Boolean);
  if (!t.length) return null;
  const hits = fences.filter((f) => {
    const name = f.name.trim().toLowerCase();
    return name.length > 0 && t.some((tag) => tag === name || tag.includes(name));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Presence basis: "if they're in the geofence, that's warehouse time."
 *
 * Any status inside the fence counts, but only between the start of the day's
 * first working segment and the end of its last — so the truck parked at the
 * yard overnight is not warehouse time. Movement statuses only count where the
 * driver stayed at the fence (next located segment is in the same fence, or it
 * is the last segment of the day), which drops drive-aways.
 */
export function detectPresenceEvents(input: DetectInput): WarehouseEvent[] {
  const opts = input.options ?? {};
  const thresholdMinutes = opts.thresholdMinutes ?? 90;
  const mergeGapMinutes = opts.mergeGapMinutes ?? 10;
  const eldDayStartHour = opts.eldDayStartHour ?? 0;
  const tzOffsetMinutes = opts.tzOffsetMinutes ?? -360;
  const gpsTolerance = (opts.gpsFallbackToleranceMinutes ?? 30) * MINUTE;
  const eldKey = (ms: number) => localDateKey(ms - eldDayStartHour * 60 * MINUTE, tzOffsetMinutes);

  if (isExcludedDriver(input.driver, opts)) return [];

  const gps = input.gpsSamples ?? [];
  const hubFence = hubFenceFromTags(opts.hubTags, input.warehouses);

  const segs = input.segments
    .filter((s) => String(s.driverId) === String(input.driver.id))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((s) => splitOnEldDay(s, { eldDayStartHour, tzOffsetMinutes }));

  const days = new Map<string, HosSegment[]>();
  for (const s of segs) {
    const key = eldKey(s.startMs);
    const arr = days.get(key) ?? [];
    arr.push(s);
    days.set(key, arr);
  }

  const events: WarehouseEvent[] = [];

  for (const [dayKey, daySegs] of days) {
    // 1. day window: first through last working segment
    const working = daySegs.filter((s) => !REST_STATUSES.has(s.status));
    if (!working.length) continue;
    const windowStart = working[0].startMs;
    const windowEnd = working[working.length - 1].endMs;

    // 2. clip to the window
    const clipped: HosSegment[] = [];
    for (const s of daySegs) {
      if (s.endMs <= windowStart || s.startMs >= windowEnd) continue;
      clipped.push({ ...s, startMs: Math.max(s.startMs, windowStart), endMs: Math.min(s.endMs, windowEnd) });
    }
    if (!clipped.length) continue;

    // 3. locate + attribute each segment
    const located = clipped.map((s) => locateSegment(s, gps, gpsTolerance));
    const atts = located.map((l, i) => {
      const own = matchGeofence(l.point, input.warehouses);
      const isWork = !REST_STATUSES.has(l.seg.status) && l.seg.status !== "driving" && l.seg.status !== "personalConveyance";
      if (isWork) {
        if (own) return { ...l, fence: own, source: l.source as LocatedSeg["source"] | "assumed_hub" };
        if (!l.point && !hasVehicle(l.seg) && hubFence) {
          return { ...l, fence: hubFence, source: "assumed_hub" as const };
        }
        return { ...l, fence: null as Geofence | null, source: l.source };
      }
      // movement / rest: only counts where the driver stayed at the fence
      if (!own) return { ...l, fence: null as Geofence | null, source: l.source };
      const isLast = i === located.length - 1;
      const next = located[i + 1];
      const nextFence = next ? matchGeofence(next.point, input.warehouses) : null;
      if (isLast || (nextFence && nextFence.id === own.id)) {
        return { ...l, fence: own, source: l.source as LocatedSeg["source"] | "assumed_hub" };
      }
      return { ...l, fence: null as Geofence | null, source: l.source };
    });

    // 4. merge consecutive at-fence segments, bridging short movement runs
    type Blk = {
      fence: Geofence;
      startMs: number;
      endMs: number;
      statuses: string[];
      sources: Set<string>;
    };
    const blocks: Blk[] = [];
    let cur: Blk | null = null;
    let gapSegs: HosSegment[] = [];
    const pushCur = () => {
      if (cur) blocks.push(cur);
      cur = null;
      gapSegs = [];
    };

    for (const a of atts) {
      if (a.fence) {
        if (cur && cur.fence.id === a.fence.id) {
          const gapMs = gapSegs.reduce((n, s) => n + (s.endMs - s.startMs), 0);
          const bridgeable =
            gapSegs.length === 0 ||
            (gapMs < mergeGapMinutes * MINUTE &&
              gapSegs.every((s) => s.status === "driving" || s.status === "yardMove"));
          if (bridgeable) {
            cur.endMs = Math.max(cur.endMs, a.seg.endMs);
            if (!cur.statuses.includes(a.seg.status)) cur.statuses.push(a.seg.status);
            cur.sources.add(a.source);
            gapSegs = [];
            continue;
          }
          pushCur();
        } else if (cur) {
          pushCur();
        }
        cur = {
          fence: a.fence,
          startMs: a.seg.startMs,
          endMs: a.seg.endMs,
          statuses: [a.seg.status],
          sources: new Set([a.source]),
        };
        gapSegs = [];
      } else if (cur) {
        gapSegs.push(a.seg);
      }
    }
    pushCur();

    // 5. threshold
    for (const b of blocks) {
      if (b.endMs - b.startMs <= thresholdMinutes * MINUTE) continue;
      const locationSource: WarehouseEvent["locationSource"] = b.sources.has("log")
        ? "log"
        : b.sources.has("vehicle_gps")
          ? "vehicle_gps"
          : b.sources.has("assumed_hub")
            ? "assumed_hub"
            : "unknown";
      events.push({
        driverId: String(input.driver.id),
        driverName: input.driver.name ?? input.segments[0]?.driverName ?? null,
        eventDate: dayKey,
        startMs: b.startMs,
        endMs: b.endMs,
        durationMin: Math.round((b.endMs - b.startMs) / MINUTE),
        addressId: b.fence.id,
        addressName: b.fence.name,
        hub: b.fence.hub ?? b.fence.name,
        statuses: b.statuses,
        locationSource,
        needsReview: false,
      });
    }
  }

  return events.sort((a, b) => a.startMs - b.startMs);
}
