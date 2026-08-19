// Read-only diagnostics for the Driver Warehouse Time module.
//
// Pulls the SAME window the sweep pulls, runs the SAME detection engine, and
// reports where the pipeline drops to zero. It performs no writes of any kind.

import {
  fetchAddresses,
  fetchDrivers,
  fetchHosLogs,
  fetchVehicleGpsHistory,
  probeSamsaraScopes,
  type SamsaraAddress,
} from "@/lib/samsara/hos.server";
import {
  KEPT_STATUSES,
  detectWarehouseEvents,
  isExcludedDriver,
  localDateKey,
  type HosSegment,
} from "@/lib/driver-time/detect";
import { haversineMeters, matchGeofence, type Geofence, type LatLon } from "@/lib/driver-time/geo";
import { CENTRAL_TZ, tzOffsetMinutesAt } from "@/lib/driver-time/tz";
import { getDriverTimeSettings, weekBounds } from "@/lib/driver-time.server";

const MINUTE = 60_000;

export type FenceKind = "circle" | "polygon" | "none";

export type FenceInfo = {
  id: string;
  name: string;
  formattedAddress: string | null;
  kind: FenceKind;
  radiusMeters: number | null;
  latitude: number | null;
  longitude: number | null;
  vertexCount: number;
};

export type StatusRow = { status: string; segments: number; minutes: number; countedAsWarehouseTime: boolean };

export type DriverRow = {
  driverId: string;
  driverName: string;
  activationStatus: string | null;
  excluded: boolean;
  segments: number;
  segmentsWithCoords: number;
  drivingMin: number;
  onDutyNonDrivingMin: number;
  offDutyMin: number;
  otherMin: number;
  longestNonDrivingMin: number;
  longestBlockStartIso: string | null;
  longestBlockEndIso: string | null;
  longestBlockStatuses: string[];
  longestBlockLocationSource: "log" | "vehicle_gps" | "unknown";
  longestBlockLat: number | null;
  longestBlockLon: number | null;
  matchedFenceName: string | null;
  nearestFenceName: string | null;
  nearestFenceMeters: number | null;
  eventsEmitted: number;
};

export type SamsaraDiagnostics = {
  ranAt: string;
  fatalError: string | null;
  windowStartIso: string;
  windowEndIso: string;
  lookbackDays: number;
  settings: {
    thresholdMinutes: number;
    mergeGapMinutes: number;
    warehouseAddressIds: string[];
    excludedDriverNamePatterns: string[];
  };
  probes: Array<{ endpoint: string; ok: boolean; detail: string }>;
  fences: FenceInfo[];
  statusVocabulary: StatusRow[];
  funnel: {
    driversOnRoster: number;
    driversAfterExclusions: number;
    segmentsFetched: number;
    segmentsWithCoords: number;
    gpsSamples: number;
    blocksBuilt: number;
    blocksOverThreshold: number;
    blocksInsideFence: number;
    eventsEmitted: number;
  };
  drivers: DriverRow[];
  warnings: string[];
};

/* --------------------------------------------------------- pure helpers */

/** Classify a Samsara address's geofence shape. */
export function classifyFence(a: Pick<SamsaraAddress, "circle" | "polygon">): FenceKind {
  if (a.polygon && a.polygon.length >= 3) return "polygon";
  if (a.circle) return "circle";
  return "none";
}

export function fenceInfoOf(a: SamsaraAddress): FenceInfo {
  const kind = classifyFence(a);
  return {
    id: a.id,
    name: a.name,
    formattedAddress: a.formattedAddress ?? null,
    kind,
    radiusMeters: kind === "circle" ? (a.circle?.radiusMeters ?? null) : null,
    latitude: a.circle?.latitude ?? (a.polygon?.length ? avg(a.polygon.map((v) => v.latitude)) : null),
    longitude: a.circle?.longitude ?? (a.polygon?.length ? avg(a.polygon.map((v) => v.longitude)) : null),
    vertexCount: a.polygon?.length ?? 0,
  };
}

function avg(xs: number[]): number | null {
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Representative point of a geofence: circle centre, or polygon vertex average. */
export function fenceCenter(g: Geofence): LatLon | null {
  if (g.circle) return { latitude: g.circle.latitude, longitude: g.circle.longitude };
  if (g.polygon?.length) {
    const la = avg(g.polygon.map((v) => v.latitude));
    const lo = avg(g.polygon.map((v) => v.longitude));
    if (la === null || lo === null) return null;
    return { latitude: la, longitude: lo };
  }
  return null;
}

/** Closest selected fence to a point, in whole metres. */
export function nearestFence(
  point: LatLon | null,
  fences: Geofence[],
): { name: string | null; meters: number | null } {
  if (!point) return { name: null, meters: null };
  let best: { name: string; meters: number } | null = null;
  for (const g of fences) {
    const c = fenceCenter(g);
    if (!c) continue;
    const meters = haversineMeters(point, c);
    if (!best || meters < best.meters) best = { name: g.name, meters };
  }
  if (!best) return { name: null, meters: null };
  return { name: best.name, meters: Math.round(best.meters) };
}

/** Status vocabulary rows with the engine's recognition verdict attached. */
export function buildStatusVocabulary(
  segments: Array<{ status: string; startMs: number; endMs: number }>,
): StatusRow[] {
  const counts = new Map<string, number>();
  const minutes = new Map<string, number>();
  for (const s of segments) {
    counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
    minutes.set(s.status, (minutes.get(s.status) ?? 0) + (s.endMs - s.startMs) / MINUTE);
  }
  return Array.from(counts.keys())
    .map((status) => ({
      status,
      segments: counts.get(status) ?? 0,
      minutes: Math.round(minutes.get(status) ?? 0),
      countedAsWarehouseTime: KEPT_STATUSES.has(status),
    }))
    .sort((a, b) => b.segments - a.segments || b.minutes - a.minutes);
}

type DiagBlock = {
  startMs: number;
  endMs: number;
  statuses: string[];
  point: LatLon | null;
  source: "log" | "vehicle_gps" | "unknown";
};

/**
 * Non-driving blocks for one driver, mirroring the detector's contiguity and
 * merge rules but WITHOUT the threshold or geofence filters, so we can see the
 * long blocks the sweep is rejecting.
 */
export function buildDiagnosticBlocks(input: {
  segments: HosSegment[];
  fences: Geofence[];
  gpsSamples: Array<{ vehicleId: string; timeMs: number; latitude: number; longitude: number }>;
  mergeGapMinutes: number;
  tzOffsetMinutes: number;
  gpsToleranceMinutes?: number;
}): Array<DiagBlock & { fenceId: string | null; fenceName: string | null }> {
  const tol = (input.gpsToleranceMinutes ?? 30) * MINUTE;
  const segs = [...input.segments].filter((s) => s.endMs > s.startMs).sort((a, b) => a.startMs - b.startMs);

  const raw: Array<{ startMs: number; endMs: number; statuses: string[]; segments: HosSegment[] }> = [];
  let current: { startMs: number; endMs: number; statuses: string[]; segments: HosSegment[] } | null = null;
  let pendingGapMs = 0;
  for (const s of segs) {
    if (KEPT_STATUSES.has(s.status)) {
      const sameDay =
        current &&
        localDateKey(current.startMs, input.tzOffsetMinutes) === localDateKey(s.startMs, input.tzOffsetMinutes);
      if (current && sameDay && s.startMs - current.endMs <= MINUTE && pendingGapMs === 0) {
        current.endMs = s.endMs;
        current.segments.push(s);
        if (!current.statuses.includes(s.status)) current.statuses.push(s.status);
      } else {
        if (current) raw.push(current);
        current = { startMs: s.startMs, endMs: s.endMs, statuses: [s.status], segments: [s] };
      }
      pendingGapMs = 0;
    } else if (current) {
      pendingGapMs += s.endMs - s.startMs;
    }
  }
  if (current) raw.push(current);

  const located = raw.map((b) => {
    let point: LatLon | null = null;
    let source: DiagBlock["source"] = "unknown";
    for (const s of b.segments) {
      if (typeof s.latitude === "number" && typeof s.longitude === "number") {
        point = { latitude: s.latitude, longitude: s.longitude };
        source = "log";
        break;
      }
    }
    if (!point) {
      const vehicleIds = new Set(b.segments.map((s) => s.vehicleId).filter(Boolean) as string[]);
      let best: { sample: (typeof input.gpsSamples)[number]; delta: number } | null = null;
      for (const sample of input.gpsSamples) {
        if (vehicleIds.size && !vehicleIds.has(sample.vehicleId)) continue;
        const delta = Math.abs(sample.timeMs - b.startMs);
        if (delta > tol) continue;
        if (!best || delta < best.delta) best = { sample, delta };
      }
      if (best) {
        point = { latitude: best.sample.latitude, longitude: best.sample.longitude };
        source = "vehicle_gps";
      }
    }
    const fence = matchGeofence(point, input.fences);
    return { startMs: b.startMs, endMs: b.endMs, statuses: b.statuses, point, source, fence };
  });

  const merged: typeof located = [];
  for (const item of located) {
    const prev = merged[merged.length - 1];
    const gap = prev ? item.startMs - prev.endMs : Infinity;
    const sameFence = prev && prev.fence && item.fence && prev.fence.id === item.fence.id;
    const sameDay =
      prev &&
      localDateKey(prev.startMs, input.tzOffsetMinutes) === localDateKey(item.startMs, input.tzOffsetMinutes);
    if (prev && sameFence && sameDay && gap < input.mergeGapMinutes * MINUTE) {
      prev.endMs = item.endMs;
      for (const st of item.statuses) if (!prev.statuses.includes(st)) prev.statuses.push(st);
      continue;
    }
    merged.push({ ...item, statuses: [...item.statuses] });
  }

  return merged.map((m) => ({
    startMs: m.startMs,
    endMs: m.endMs,
    statuses: m.statuses,
    point: m.point,
    source: m.source,
    fenceId: m.fence?.id ?? null,
    fenceName: m.fence?.name ?? null,
  }));
}

const OFF_DUTY = new Set(["offDuty", "sleeperBerth", "sleeperBed"]);

/* ------------------------------------------------------------------ runner */

function ianaZoneFor(tz: string | null | undefined): string {
  const raw = (tz ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower === "america/new_york" || lower === "est" || lower === "edt" || lower === "et") return "America/New_York";
  if (raw.includes("/")) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
      return raw;
    } catch {
      /* fall through */
    }
  }
  return CENTRAL_TZ;
}

export async function runSamsaraDiagnostics(opts?: {
  now?: Date;
  lookbackDays?: number;
}): Promise<SamsaraDiagnostics> {
  const now = opts?.now ?? new Date();
  const lookbackDays = opts?.lookbackDays ?? 8;
  const { weekEnd } = weekBounds(now);
  const endMs = Math.min(Date.parse(`${weekEnd}T23:59:59Z`), now.getTime());
  const startMs = endMs - lookbackDays * 86_400_000;
  const warnings: string[] = [];

  const settings = await getDriverTimeSettings();
  const probes = await probeSamsaraScopes();
  const [drivers, addresses] = await Promise.all([fetchDrivers(), fetchAddresses()]);

  const selected = settings.warehouseAddressIds.length
    ? addresses.filter((a) => settings.warehouseAddressIds.includes(a.id))
    : [];
  if (!selected.length) warnings.push("No warehouse addresses are selected in Settings, so nothing can ever match.");

  const fences: FenceInfo[] = selected.map(fenceInfoOf);
  const warehouses: Geofence[] = selected.map((a) => ({
    id: a.id,
    name: a.name,
    hub: a.name,
    tz: settings.hubTzByAddress[a.id] ?? null,
    circle: a.circle,
    polygon: a.polygon,
  }));

  const exclusionOpts = {
    excludedDriverIds: settings.excludedDriverIds,
    excludedDriverNamePatterns: settings.excludedDriverNamePatterns,
  };
  const roster = drivers.filter((d) => !isExcludedDriver({ id: d.id, name: d.name }, exclusionOpts));

  const driverIds = roster.map((d) => d.id);
  const segments = driverIds.length ? await fetchHosLogs({ startMs, endMs, driverIds }) : [];

  let gpsSamples: Array<{ vehicleId: string; timeMs: number; latitude: number; longitude: number }> = [];
  const needGps = segments.some((s) => s.latitude === null || s.longitude === null);
  if (needGps) {
    const vehicleIds = Array.from(new Set(segments.map((s) => s.vehicleId).filter(Boolean) as string[]));
    try {
      gpsSamples = await fetchVehicleGpsHistory({ startMs, endMs, vehicleIds });
    } catch (e: any) {
      warnings.push(`GPS fallback unavailable: ${e?.message ?? String(e)}`);
    }
  }

  const byDriver = new Map<string, HosSegment[]>();
  for (const s of segments) {
    const arr = byDriver.get(s.driverId) ?? [];
    arr.push(s as HosSegment);
    byDriver.set(s.driverId, arr);
  }

  let blocksBuilt = 0;
  let blocksOverThreshold = 0;
  let blocksInsideFence = 0;
  let eventsEmitted = 0;

  const rows: DriverRow[] = [];
  for (const d of drivers) {
    const excluded = isExcludedDriver({ id: d.id, name: d.name }, exclusionOpts);
    const segs = byDriver.get(d.id) ?? [];
    const tzOffsetMinutes = tzOffsetMinutesAt(now, ianaZoneFor(d.timezone));

    let drivingMin = 0;
    let onDutyNonDrivingMin = 0;
    let offDutyMin = 0;
    let otherMin = 0;
    let segmentsWithCoords = 0;
    for (const s of segs) {
      const min = (s.endMs - s.startMs) / MINUTE;
      if (typeof s.latitude === "number" && typeof s.longitude === "number") segmentsWithCoords++;
      if (KEPT_STATUSES.has(s.status)) onDutyNonDrivingMin += min;
      else if (s.status === "driving") drivingMin += min;
      else if (OFF_DUTY.has(s.status)) offDutyMin += min;
      else otherMin += min;
    }

    const blocks = excluded
      ? []
      : buildDiagnosticBlocks({
          segments: segs,
          fences: warehouses,
          gpsSamples,
          mergeGapMinutes: settings.mergeGapMinutes,
          tzOffsetMinutes,
        });

    blocksBuilt += blocks.length;
    for (const b of blocks) {
      if ((b.endMs - b.startMs) / MINUTE >= settings.thresholdMinutes) blocksOverThreshold++;
      if (b.fenceId) blocksInsideFence++;
    }

    const longest = blocks.reduce<(typeof blocks)[number] | null>(
      (best, b) => (!best || b.endMs - b.startMs > best.endMs - best.startMs ? b : best),
      null,
    );
    const near = nearestFence(longest?.point ?? null, warehouses);

    let events: ReturnType<typeof detectWarehouseEvents> = [];
    if (!excluded && segs.length) {
      events = detectWarehouseEvents({
        driver: { id: d.id, name: d.name },
        segments: segs,
        warehouses,
        gpsSamples,
        options: {
          thresholdMinutes: settings.thresholdMinutes,
          mergeGapMinutes: settings.mergeGapMinutes,
          eldDayStartHour: d.eldDayStartHour ?? 0,
          tzOffsetMinutes,
          excludedDriverIds: settings.excludedDriverIds,
          excludedDriverNamePatterns: settings.excludedDriverNamePatterns,
        },
      });
    }
    eventsEmitted += events.length;

    rows.push({
      driverId: d.id,
      driverName: d.name,
      activationStatus: d.driverActivationStatus,
      excluded,
      segments: segs.length,
      segmentsWithCoords,
      drivingMin: Math.round(drivingMin),
      onDutyNonDrivingMin: Math.round(onDutyNonDrivingMin),
      offDutyMin: Math.round(offDutyMin),
      otherMin: Math.round(otherMin),
      longestNonDrivingMin: longest ? Math.round((longest.endMs - longest.startMs) / MINUTE) : 0,
      longestBlockStartIso: longest ? new Date(longest.startMs).toISOString() : null,
      longestBlockEndIso: longest ? new Date(longest.endMs).toISOString() : null,
      longestBlockStatuses: longest?.statuses ?? [],
      longestBlockLocationSource: longest?.source ?? "unknown",
      longestBlockLat: longest?.point?.latitude ?? null,
      longestBlockLon: longest?.point?.longitude ?? null,
      matchedFenceName: longest?.fenceName ?? null,
      nearestFenceName: near.name,
      nearestFenceMeters: near.meters,
      eventsEmitted: events.length,
    });
  }

  rows.sort((a, b) =>
    a.excluded === b.excluded
      ? b.longestNonDrivingMin - a.longestNonDrivingMin
      : a.excluded
        ? 1
        : -1,
  );

  if (fences.some((f) => f.kind === "none")) {
    warnings.push("One or more selected warehouse addresses have no geofence shape in Samsara.");
  }

  return {
    ranAt: new Date().toISOString(),
    fatalError: null,
    windowStartIso: new Date(startMs).toISOString(),
    windowEndIso: new Date(endMs).toISOString(),
    lookbackDays,
    settings: {
      thresholdMinutes: settings.thresholdMinutes,
      mergeGapMinutes: settings.mergeGapMinutes,
      warehouseAddressIds: settings.warehouseAddressIds,
      excludedDriverNamePatterns: settings.excludedDriverNamePatterns,
    },
    probes,
    fences,
    statusVocabulary: buildStatusVocabulary(segments),
    funnel: {
      driversOnRoster: drivers.length,
      driversAfterExclusions: roster.length,
      segmentsFetched: segments.length,
      segmentsWithCoords: segments.filter((s) => s.latitude !== null && s.longitude !== null).length,
      gpsSamples: gpsSamples.length,
      blocksBuilt,
      blocksOverThreshold,
      blocksInsideFence,
      eventsEmitted,
    },
    drivers: rows,
    warnings,
  };
}
