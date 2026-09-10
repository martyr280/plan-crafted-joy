import {
  fetchAddresses,
  fetchDrivers,
  fetchHosLogs,
  fetchVehicleGpsHistory,
  samsaraApi,
  type NormalizedHosSegment,
  type SamsaraAddress,
  type SamsaraDriver,
} from "../src/lib/samsara/hos.server";
import { getDriverTimeSettings } from "../src/lib/driver-time.server";
import {
  haversineMeters,
  pointInGeofence,
  type Geofence,
  type LatLon,
} from "../src/lib/driver-time/geo";
import { tzOffsetMinutesAt } from "../src/lib/tz";

const MINUTE = 60_000;

type Case = {
  driver: string;
  hub: "Ocala" | "Birmingham" | "Dallas";
  date: string;
  official: string;
  fuzzyJohnson?: boolean;
};

type RawDriver = {
  id?: string;
  name?: string;
  licenseNumber?: string | null;
  licenseState?: string | null;
  username?: string | null;
  data?: RawDriver;
};

const cases: Case[] = [
  { driver: "Joseph Outler", hub: "Ocala", date: "2026-08-17", official: "8:28am–4:35pm ET" },
  { driver: "Kennedy Loyd", hub: "Birmingham", date: "2026-08-26", official: "3:00am–4:29pm CT" },
  { driver: "Karriem Farahkhan", hub: "Birmingham", date: "2026-08-28", official: "6:15am–2:52pm CT" },
  { driver: "DJ Johnson", hub: "Dallas", date: "2026-08-21", official: "9:52am–9:00pm CT", fuzzyJohnson: true },
];

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function localMidnight(date: string, timeZone: string): number {
  const anchor = new Date(`${date}T12:00:00Z`);
  return Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutesAt(anchor, timeZone) * MINUTE;
}

function localTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

function bestNameMatch(target: string, roster: SamsaraDriver[]): SamsaraDriver | null {
  const exact = roster.find((driver) => normalizedName(driver.name) === normalizedName(target));
  if (exact) return exact;
  return [...roster].sort(
    (a, b) => editDistance(normalizedName(target), normalizedName(a.name)) - editDistance(normalizedName(target), normalizedName(b.name)),
  )[0] ?? null;
}

function selectedFences(addresses: SamsaraAddress[], ids: string[]): Geofence[] {
  return addresses
    .filter((address) => ids.includes(address.id))
    .map((address) => ({
      id: address.id,
      name: address.name,
      circle: address.circle,
      polygon: address.polygon,
    }));
}

function distanceToFence(point: LatLon, fence: Geofence): number | null {
  if (pointInGeofence(point, fence)) return 0;
  if (fence.circle) {
    return Math.max(0, haversineMeters(point, fence.circle) - fence.circle.radiusMeters);
  }
  if (fence.polygon?.length) {
    return Math.min(...fence.polygon.map((vertex) => haversineMeters(point, vertex)));
  }
  return null;
}

function nearestFence(point: LatLon | null, fences: Geofence[]): { name: string; meters: number } | null {
  if (!point) return null;
  let nearest: { name: string; meters: number } | null = null;
  for (const fence of fences) {
    const meters = distanceToFence(point, fence);
    if (meters === null) continue;
    if (!nearest || meters < nearest.meters) nearest = { name: fence.name, meters };
  }
  return nearest ? { name: nearest.name, meters: Math.round(nearest.meters) } : null;
}

function isOnDutyOrYardMove(status: string): boolean {
  const normalized = status.toLowerCase().replace(/[^a-z]/g, "");
  return normalized === "onduty" || normalized === "yardmove" || normalized === "ondutynotdriving";
}

function rawDriverObject(value: RawDriver): RawDriver {
  return value.data && typeof value.data === "object" ? value.data : value;
}

function caseTimeZone(hub: Case["hub"]): string {
  return hub === "Ocala" ? "America/New_York" : "America/Chicago";
}

const settings = await getDriverTimeSettings();
const [roster, addresses] = await Promise.all([fetchDrivers(), fetchAddresses()]);
const fences = selectedFences(addresses, settings.warehouseAddressIds);
const rawById = new Map<string, RawDriver>();

for (const driver of roster) {
  const raw = rawDriverObject(await samsaraApi<RawDriver>(`/fleet/drivers/${encodeURIComponent(driver.id)}`));
  rawById.set(driver.id, raw);
}

console.log("=== FULL ROSTER ===");
for (const driver of roster) {
  const raw = rawById.get(driver.id);
  console.log(JSON.stringify({
    id: driver.id,
    name: driver.name,
    activationStatus: driver.driverActivationStatus,
    licenseNumberPresent: Boolean(raw?.licenseNumber),
  }));
}

console.log("=== SELECTED WAREHOUSE GEOFENCES ===");
for (const fence of fences) console.log(JSON.stringify(fence));

for (const item of cases) {
  const timeZone = caseTimeZone(item.hub);
  console.log(`=== CASE: ${item.driver} | ${item.hub} | ${item.date} | official ${item.official} ===`);

  if (item.fuzzyJohnson) {
    console.log("JOHNSON ROSTER ROWS:");
    for (const driver of roster.filter((row) => row.name.toLowerCase().includes("johnson"))) {
      console.log(JSON.stringify(driver));
    }
  }

  const driver = bestNameMatch(item.driver, roster);
  if (!driver) {
    console.log("DRIVER MATCH: none");
    continue;
  }
  const raw = rawById.get(driver.id);
  console.log("DRIVER REGISTRY RECORD:");
  console.log(JSON.stringify({
    id: driver.id,
    name: driver.name,
    activationStatus: driver.driverActivationStatus,
    timezone: driver.timezone,
    eldDayStartHour: driver.eldDayStartHour,
    licenseNumber: raw?.licenseNumber ?? null,
    licenseState: raw?.licenseState ?? null,
    username: raw?.username ?? null,
  }));

  const startMs = localMidnight(item.date, timeZone);
  const endMs = localMidnight(addDays(item.date, 1), timeZone);
  console.log(`WINDOW: ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()} (${timeZone})`);

  const segments = await fetchHosLogs({ startMs, endMs, driverIds: [driver.id] });
  const vehicleIds = Array.from(new Set(segments.map((segment) => segment.vehicleId).filter(Boolean) as string[]));
  const gps = await fetchVehicleGpsHistory({ startMs, endMs, vehicleIds });

  console.log("HOS SEGMENTS:");
  if (!segments.length) console.log("none");
  for (const segment of segments) {
    const point = segment.latitude === null || segment.longitude === null
      ? null
      : { latitude: segment.latitude, longitude: segment.longitude };
    const nearest = nearestFence(point, fences);
    console.log(JSON.stringify({
      status: segment.status,
      startLocal: localTime(segment.startMs, timeZone),
      endLocal: localTime(segment.endMs, timeZone),
      durationMin: (segment.endMs - segment.startMs) / MINUTE,
      coordinates: point ?? "none",
      vehicleId: segment.vehicleId,
      nearestSelectedFence: nearest?.name ?? null,
      distanceMeters: nearest?.meters ?? null,
    }));
  }

  console.log("GPS EVIDENCE:");
  if (!vehicleIds.length) console.log("none");
  for (const vehicleId of vehicleIds) {
    const samples = gps.filter((sample) => sample.vehicleId === vehicleId).sort((a, b) => a.timeMs - b.timeMs);
    const fractions: Record<string, number | null> = {};
    for (const fence of fences) {
      const inside = samples.filter((sample) => pointInGeofence(sample, fence)).length;
      fractions[fence.name] = samples.length ? inside / samples.length : null;
    }
    console.log(JSON.stringify({
      vehicleId,
      sampleCount: samples.length,
      firstSampleLocal: samples.length ? localTime(samples[0].timeMs, timeZone) : null,
      lastSampleLocal: samples.length ? localTime(samples[samples.length - 1].timeMs, timeZone) : null,
      fractionInsideEachSelectedFence: fractions,
    }));
  }

  const minutesByStatus: Record<string, number> = {};
  let minutesInsideAnyFence = 0;
  let minutesInsideAnyFenceOnDutyOrYardMove = 0;
  for (const segment of segments) {
    const minutes = (segment.endMs - segment.startMs) / MINUTE;
    minutesByStatus[segment.status] = (minutesByStatus[segment.status] ?? 0) + minutes;
    const point = segment.latitude === null || segment.longitude === null
      ? null
      : { latitude: segment.latitude, longitude: segment.longitude };
    const inside = point ? fences.some((fence) => pointInGeofence(point, fence)) : false;
    if (inside) {
      minutesInsideAnyFence += minutes;
      if (isOnDutyOrYardMove(segment.status)) minutesInsideAnyFenceOnDutyOrYardMove += minutes;
    }
  }
  console.log("PER-DAY TOTALS:");
  console.log(JSON.stringify({
    minutesByStatus,
    minutesLocatedInsideFenceAnyStatus: minutesInsideAnyFence,
    minutesLocatedInsideFenceOnDutyOrYardMoveOnly: minutesInsideAnyFenceOnDutyOrYardMove,
  }));
}