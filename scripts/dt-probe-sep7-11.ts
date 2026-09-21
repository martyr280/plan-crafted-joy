// READ-ONLY Samsara evidence probe for the Sep 7–11 reconciliation.
// Calls Samsara directly (no cache layer, no DB writes).
import {
  fetchAddresses,
  fetchDailyLogs,
  fetchDriverVehicleAssignments,
  fetchDrivers,
  fetchHosLogs,
  fetchVehicleGpsHistory,
  samsaraPaged,
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

type Case = { driver: string; hub: "Birmingham" | "Dallas" | "Ocala"; dates: string[] };

const cases: Case[] = [
  { driver: "Gilbert Hinton", hub: "Birmingham", dates: ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"] },
  { driver: "Jawan McGinnis", hub: "Birmingham", dates: ["2026-09-08", "2026-09-11"] },
  { driver: "Alberto Fiscal", hub: "Dallas", dates: ["2026-09-09"] },
  { driver: "DJ Johnson", hub: "Dallas", dates: ["2026-09-11"] },
  { driver: "Melvin Gilbert", hub: "Dallas", dates: ["2026-09-11"] },
  { driver: "Nelson Roldan", hub: "Dallas", dates: ["2026-09-11"] },
  { driver: "Kennedy Loyd", hub: "Birmingham", dates: ["2026-09-08"] },
];

function tzFor(hub: Case["hub"]): string {
  return hub === "Ocala" ? "America/New_York" : "America/Chicago";
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localMidnight(date: string, timeZone: string): number {
  const anchor = new Date(`${date}T12:00:00Z`);
  return Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutesAt(anchor, timeZone) * MINUTE;
}

function localTime(ms: number | null | undefined, timeZone: string): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
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

function norm(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = saved;
    }
  }
  return row[b.length];
}

function bestNameMatch(target: string, roster: SamsaraDriver[]): SamsaraDriver | null {
  const exact = roster.find((d) => norm(d.name) === norm(target));
  if (exact) return exact;
  return [...roster].sort(
    (a, b) => editDistance(norm(target), norm(a.name)) - editDistance(norm(target), norm(b.name)),
  )[0] ?? null;
}

function selectedFences(addresses: SamsaraAddress[], ids: string[]): Geofence[] {
  return addresses
    .filter((a) => ids.includes(a.id))
    .map((a) => ({ id: a.id, name: a.name, circle: a.circle, polygon: a.polygon }));
}

function distanceToFence(p: LatLon, fence: Geofence): number | null {
  if (pointInGeofence(p, fence)) return 0;
  if (fence.circle) return Math.max(0, haversineMeters(p, fence.circle) - fence.circle.radiusMeters);
  if (fence.polygon?.length) return Math.min(...fence.polygon.map((v) => haversineMeters(p, v)));
  return null;
}

function nearestFence(p: LatLon | null, fences: Geofence[]): { name: string; meters: number } | null {
  if (!p) return null;
  let best: { name: string; meters: number } | null = null;
  for (const fence of fences) {
    const meters = distanceToFence(p, fence);
    if (meters === null) continue;
    if (!best || meters < best.meters) best = { name: fence.name, meters };
  }
  return best ? { name: best.name, meters: Math.round(best.meters) } : null;
}

function fenceShape(fence: Geofence) {
  if (fence.polygon?.length) {
    const lat = fence.polygon.reduce((s, v) => s + v.latitude, 0) / fence.polygon.length;
    const lon = fence.polygon.reduce((s, v) => s + v.longitude, 0) / fence.polygon.length;
    return { shape: "polygon", vertexCount: fence.polygon.length, radiusMeters: null, center: { latitude: lat, longitude: lon } };
  }
  if (fence.circle) {
    return {
      shape: "circle",
      vertexCount: null,
      radiusMeters: fence.circle.radiusMeters,
      center: { latitude: fence.circle.latitude, longitude: fence.circle.longitude },
    };
  }
  return { shape: "none", vertexCount: null, radiusMeters: null, center: null };
}

/** Raw HOS log entries, so logRecordedLocation can be printed verbatim. */
async function rawHosLogs(startMs: number, endMs: number, driverId: string): Promise<any[]> {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    driverIds: driverId,
  });
  const rows = await samsaraPaged<any>(`/fleet/hos/logs?${params.toString()}`, (d) => d.data ?? []);
  const out: any[] = [];
  for (const row of rows) out.push(...(row.hosLogs ?? row.logs ?? []));
  return out;
}

function insideRanges(
  samples: Array<{ timeMs: number; latitude: number; longitude: number }>,
  fences: Geofence[],
  timeZone: string,
) {
  const ranges: Array<{ fence: string; startLocal: string | null; endLocal: string | null; durationMin: number; samples: number }> = [];
  let current: { fence: string; startMs: number; endMs: number; samples: number } | null = null;
  for (const sample of samples) {
    const hit = fences.find((f) => pointInGeofence(sample, f)) ?? null;
    if (hit && current && current.fence === hit.name) {
      current.endMs = sample.timeMs;
      current.samples += 1;
      continue;
    }
    if (current) {
      ranges.push({
        fence: current.fence,
        startLocal: localTime(current.startMs, timeZone),
        endLocal: localTime(current.endMs, timeZone),
        durationMin: Math.round(((current.endMs - current.startMs) / MINUTE) * 10) / 10,
        samples: current.samples,
      });
      current = null;
    }
    if (hit) current = { fence: hit.name, startMs: sample.timeMs, endMs: sample.timeMs, samples: 1 };
  }
  if (current) {
    ranges.push({
      fence: current.fence,
      startLocal: localTime(current.startMs, timeZone),
      endLocal: localTime(current.endMs, timeZone),
      durationMin: Math.round(((current.endMs - current.startMs) / MINUTE) * 10) / 10,
      samples: current.samples,
    });
  }
  return ranges;
}

function dailyMinutes(raw: any) {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = raw?.[k];
      if (typeof v === "number") return Math.round(v / MINUTE);
    }
    return null;
  };
  return {
    onDutyMin: pick("onDutyDurationMs", "onDutyTimeDurationMs", "totalOnDutyDurationMs"),
    drivingMin: pick("drivingDurationMs", "timeDrivingDurationMs", "totalDrivingDurationMs"),
    offDutyMin: pick("offDutyDurationMs", "timeOffDutyDurationMs", "totalOffDutyDurationMs"),
  };
}

async function main() {
  const settings = await getDriverTimeSettings();
  const [roster, addresses] = await Promise.all([fetchDrivers(), fetchAddresses()]);
  const fences = selectedFences(addresses, settings.warehouseAddressIds);

  console.log("=== SELECTED WAREHOUSE GEOFENCES ===");
  for (const fence of fences) {
    console.log(JSON.stringify({ id: fence.id, name: fence.name, ...fenceShape(fence) }));
  }

  console.log("=== FULL ROSTER ===");
  for (const d of roster) {
    console.log(JSON.stringify({
      id: d.id,
      name: d.name,
      activationStatus: d.driverActivationStatus,
      licensePresent: Boolean(d.licenseNumber),
      tags: d.tags,
    }));
  }

  for (const item of cases) {
    const timeZone = tzFor(item.hub);
    const driver = bestNameMatch(item.driver, roster);
    for (const date of item.dates) {
      console.log(`=== CASE: ${item.driver} | ${item.hub} | ${date} | tz ${timeZone} ===`);
      if (!driver) {
        console.log("DRIVER MATCH: none");
        continue;
      }
      console.log("(a) DRIVER REGISTRY RECORD:");
      console.log(JSON.stringify({
        id: driver.id,
        name: driver.name,
        activationStatus: driver.driverActivationStatus,
        timezone: driver.timezone,
        eldDayStartHour: driver.eldDayStartHour,
        licenseNumberPresent: Boolean(driver.licenseNumber),
        licenseState: driver.licenseState,
        username: driver.username,
        tags: driver.tags,
      }));

      const startMs = localMidnight(date, timeZone);
      const endMs = localMidnight(addDays(date, 1), timeZone);
      console.log(`WINDOW: ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()}`);

      let segments: Awaited<ReturnType<typeof fetchHosLogs>> = [];
      let raws: any[] = [];
      try {
        segments = await fetchHosLogs({ startMs, endMs, driverIds: [driver.id] });
      } catch (e: any) {
        console.log(`ERROR fetchHosLogs: ${e?.message ?? e}`);
      }
      try {
        raws = await rawHosLogs(startMs, endMs, driver.id);
      } catch (e: any) {
        console.log(`ERROR raw hos logs: ${e?.message ?? e}`);
      }

      console.log("(b) HOS SEGMENTS:");
      if (!segments.length) console.log("none");
      for (const s of segments) {
        const point = s.latitude === null || s.longitude === null ? null : { latitude: s.latitude, longitude: s.longitude };
        const near = nearestFence(point, fences);
        const match = raws.find((r) => Date.parse(r.logStartTime ?? "") === s.startMs)
          ?? raws.find((r) => Math.abs(Date.parse(r.logStartTime ?? "") - s.startMs) < 1000);
        console.log(JSON.stringify({
          status: s.status,
          startLocal: localTime(s.startMs, timeZone),
          endLocal: localTime(s.endMs, timeZone),
          durationMin: Math.round(((s.endMs - s.startMs) / MINUTE) * 10) / 10,
          coordinates: point ?? "none",
          vehicleId: s.vehicleId ?? "none",
          logRecordedLocation: match?.logRecordedLocation ?? null,
          nearestSelectedFence: near?.name ?? null,
          distanceMeters: near?.meters ?? null,
        }));
      }

      let assignments: Awaited<ReturnType<typeof fetchDriverVehicleAssignments>> = [];
      try {
        assignments = await fetchDriverVehicleAssignments({ startMs, endMs, driverIds: [driver.id] });
      } catch (e: any) {
        console.log(`ERROR fetchDriverVehicleAssignments: ${e?.message ?? e}`);
      }
      console.log("(c) DRIVER-VEHICLE ASSIGNMENTS:");
      if (!assignments.length) console.log("none");
      for (const a of assignments) {
        console.log(JSON.stringify({
          vehicleId: a.vehicleId,
          vehicleName: a.vehicleName,
          startLocal: localTime(a.startMs, timeZone),
          endLocal: localTime(a.endMs, timeZone),
          assignmentType: a.assignmentType,
        }));
      }

      const vehicleIds = Array.from(new Set([
        ...segments.map((s) => s.vehicleId).filter(Boolean) as string[],
        ...assignments.map((a) => a.vehicleId),
      ]));
      console.log("(d) VEHICLE GPS:");
      if (!vehicleIds.length) console.log("none");
      let gps: Awaited<ReturnType<typeof fetchVehicleGpsHistory>> = [];
      if (vehicleIds.length) {
        try {
          gps = await fetchVehicleGpsHistory({ startMs, endMs, vehicleIds });
        } catch (e: any) {
          console.log(`ERROR fetchVehicleGpsHistory: ${e?.message ?? e}`);
        }
      }
      for (const vehicleId of vehicleIds) {
        const samples = gps.filter((g) => g.vehicleId === vehicleId).sort((a, b) => a.timeMs - b.timeMs);
        console.log(JSON.stringify({
          vehicleId,
          sampleCount: samples.length,
          firstSampleLocal: samples.length ? localTime(samples[0].timeMs, timeZone) : null,
          lastSampleLocal: samples.length ? localTime(samples[samples.length - 1].timeMs, timeZone) : null,
        }));
        const ranges = insideRanges(samples, fences, timeZone);
        console.log(`INSIDE-FENCE RANGES for ${vehicleId}:`);
        if (!ranges.length) console.log("none");
        for (const r of ranges) console.log(JSON.stringify(r));
      }

      console.log("(e) SAMSARA DAILY LOG:");
      try {
        const logs = await fetchDailyLogs({ startMs, endMs, driverIds: [driver.id] });
        const rows = logs.filter((l) => (l.logDate ? l.logDate === date : true));
        if (!rows.length) console.log("none");
        for (const l of rows) {
          console.log(JSON.stringify({
            logDate: l.logDate,
            startLocal: localTime(l.startMs, timeZone),
            endLocal: localTime(l.endMs, timeZone),
            ...dailyMinutes(l.raw),
          }));
        }
      } catch (e: any) {
        console.log(`ERROR fetchDailyLogs: ${e?.message ?? e}`);
      }
    }
  }
}

await main();
