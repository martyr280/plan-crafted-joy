// READ-ONLY Samsara evidence probe #3 — DJ Johnson follow-up, per-vehicle.
// Calls Samsara directly (no cache layer, no DB writes).
import { samsaraPaged, fetchAddresses } from "../src/lib/samsara/hos.server";
import { getDriverTimeSettings } from "../src/lib/driver-time.server";
import { pointInGeofence, type Geofence } from "../src/lib/driver-time/geo";
import { tzOffsetMinutesAt } from "../src/lib/tz";

const MINUTE = 60_000;
const CT = "America/Chicago";
const DJ = "53243889";
const VEHICLES = [
  { id: "281474996579824", unit: "443627" },
  { id: "281474996579825", unit: "589566" },
];
const DATES = ["2026-09-11", "2026-08-21"];

function localMidnight(date: string, tz = CT): number {
  const anchor = new Date(`${date}T12:00:00Z`);
  return Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutesAt(anchor, tz) * MINUTE;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localTime(ms: number | null | undefined, tz = CT): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function hms(ms: number): string {
  return (localTime(ms) ?? "").slice(11);
}

function J(v: unknown) {
  return JSON.stringify(v);
}

type Sample = { timeMs: number; latitude: number; longitude: number };

async function statsHistory(startMs: number, endMs: number, vehicleId: string) {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    types: "engineStates,gps",
    vehicleIds: vehicleId,
  });
  const rows = await samsaraPaged<any>(`/fleet/vehicles/stats/history?${params.toString()}`, (d) => d.data ?? []);
  const engine: Array<{ timeMs: number; value: string }> = [];
  const gps: Sample[] = [];
  let rowsSeen = 0;
  let rowsKept = 0;
  for (const v of rows) {
    rowsSeen += 1;
    if (String(v.id) !== vehicleId) continue; // endpoint can ignore the id filter
    rowsKept += 1;
    for (const e of v.engineStates ?? []) {
      const t = Date.parse(e.time ?? "");
      if (Number.isFinite(t)) engine.push({ timeMs: t, value: String(e.value ?? "") });
    }
    for (const g of v.gps ?? []) {
      const t = Date.parse(g.time ?? "");
      if (!Number.isFinite(t)) continue;
      if (typeof g.latitude !== "number" || typeof g.longitude !== "number") continue;
      gps.push({ timeMs: t, latitude: g.latitude, longitude: g.longitude });
    }
  }
  engine.sort((a, b) => a.timeMs - b.timeMs);
  gps.sort((a, b) => a.timeMs - b.timeMs);
  return { engine, gps, rowsSeen, rowsKept };
}

type Range = { fence: string; startMs: number; endMs: number; samples: number };

function insideRanges(samples: Sample[], fences: Geofence[]): Range[] {
  const out: Range[] = [];
  let cur: Range | null = null;
  for (const s of samples) {
    const hit = fences.find((f) => pointInGeofence(s, f)) ?? null;
    if (hit && cur && cur.fence === hit.name) {
      cur.endMs = s.timeMs;
      cur.samples += 1;
      continue;
    }
    if (cur) {
      out.push(cur);
      cur = null;
    }
    if (hit) cur = { fence: hit.name, startMs: s.timeMs, endMs: s.timeMs, samples: 1 };
  }
  if (cur) out.push(cur);
  return out;
}

/** Merge same-fence ranges separated by less than 3 minutes. */
function mergeRanges(ranges: Range[], gapMs = 3 * MINUTE): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    if (prev && prev.fence === r.fence && r.startMs - prev.endMs < gapMs) {
      prev.endMs = r.endMs;
      prev.samples += r.samples;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

function printRanges(label: string, ranges: Range[]) {
  console.log(label);
  if (!ranges.length) console.log("none");
  for (const r of ranges) {
    console.log(J({
      fence: r.fence,
      startLocal: localTime(r.startMs),
      endLocal: localTime(r.endMs),
      durationMin: Math.round(((r.endMs - r.startMs) / MINUTE) * 10) / 10,
      samples: r.samples,
    }));
  }
}

async function assignmentsByVehicle(startMs: number, endMs: number, vehicleId: string) {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    filterBy: "vehicles",
    vehicleIds: vehicleId,
  });
  return samsaraPaged<any>(`/fleet/driver-vehicle-assignments?${params.toString()}`, (d) => d.data ?? []);
}

async function rawGet(path: string): Promise<{ status: number | string; body: string }> {
  try {
    const res = await fetch(`https://api.samsara.com${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.SAMSARA_API_TOKEN ?? ""}`,
        Accept: "application/json",
      },
    });
    return { status: res.status, body: await res.text().catch(() => "") };
  } catch (e: any) {
    return { status: "fetch error", body: String(e?.message ?? e) };
  }
}

async function rawHosLogs(startMs: number, endMs: number, driverId: string): Promise<any[]> {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    driverIds: driverId,
  });
  const rows = await samsaraPaged<any>(`/fleet/hos/logs?${params.toString()}`, (d) => d.data ?? []);
  const out: any[] = [];
  for (const row of rows) for (const l of row.hosLogs ?? row.logs ?? []) out.push(l);
  return out;
}

async function main() {
  const settings = await getDriverTimeSettings();
  const addresses = await fetchAddresses();
  const allFences: Geofence[] = addresses
    .filter((a) => settings.warehouseAddressIds.includes(a.id))
    .map((a) => ({ id: a.id, name: a.name, circle: a.circle, polygon: a.polygon }));
  const dallasFences = allFences.filter((f) => /dallas/i.test(f.name));

  console.log("=== FENCES ===");
  console.log(J({ selected: allFences.map((f) => ({ id: f.id, name: f.name })), dallas: dallasFences.map((f) => f.name) }));

  for (const date of DATES) {
    const startMs = localMidnight(date);
    const endMs = localMidnight(addDays(date, 1));
    for (const veh of VEHICLES) {
      console.log(`\n\n########## VEHICLE ${veh.id} (unit ${veh.unit}) | ${date} | CT window ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()} ##########`);

      let gps: Sample[] = [];
      try {
        const { engine, gps: g, rowsSeen, rowsKept } = await statsHistory(startMs, endMs, veh.id);
        gps = g;
        console.log(J({ statsRowsReturned: rowsSeen, statsRowsMatchingVehicle: rowsKept, engineStateCount: engine.length, gpsSampleCount: gps.length }));

        console.log("(a) ENGINE STATE TRANSITIONS:");
        let prev: string | null = null;
        let printed = 0;
        for (const e of engine) {
          if (e.value === prev) continue;
          console.log(`${hms(e.timeMs)}  ${e.value}`);
          prev = e.value;
          printed += 1;
        }
        if (!printed) console.log("none");

        console.log("(b) GPS:");
        console.log(J({
          gpsSampleCount: gps.length,
          firstSampleLocal: gps.length ? localTime(gps[0].timeMs) : null,
          lastSampleLocal: gps.length ? localTime(gps[gps.length - 1].timeMs) : null,
        }));
        const raw = insideRanges(gps, dallasFences);
        printRanges("INSIDE DALLAS FENCE RANGES (raw, consecutive samples):", raw);
        printRanges("INSIDE DALLAS FENCE RANGES (merged, gaps < 3 min):", mergeRanges(raw));
        const anyRaw = insideRanges(gps, allFences);
        printRanges("INSIDE ANY SELECTED FENCE RANGES (merged, gaps < 3 min):", mergeRanges(anyRaw));
      } catch (e: any) {
        console.log(`ERROR stats history: ${e?.message ?? e}`);
      }

      console.log("(c) DRIVER-VEHICLE ASSIGNMENTS (filterBy=vehicles):");
      try {
        const rows = await assignmentsByVehicle(startMs, endMs, veh.id);
        let count = 0;
        for (const row of rows) {
          const list = Array.isArray(row.assignments) ? row.assignments : [row];
          for (const a of list) {
            count += 1;
            console.log(J({
              driverId: String(a.driver?.id ?? row.driver?.id ?? row.driverId ?? ""),
              driverName: a.driver?.name ?? row.driver?.name ?? null,
              vehicleId: String(a.vehicle?.id ?? row.vehicle?.id ?? row.vehicleId ?? ""),
              vehicleName: a.vehicle?.name ?? row.vehicle?.name ?? null,
              startLocal: localTime(Date.parse(a.startTime ?? a.assignedAtTime ?? "")),
              endLocal: localTime(Date.parse(a.endTime ?? "")),
              assignmentType: a.assignmentType ?? null,
            }));
          }
        }
        if (!count) console.log("none");
      } catch (e: any) {
        console.log(`ERROR assignments: ${e?.message ?? e}`);
      }

      console.log("(d) LEGACY TRIPS:");
      const p1 = `/v1/fleet/trips?vehicleId=${veh.id}&startMs=${startMs}&endMs=${endMs}`;
      const r1 = await rawGet(p1);
      console.log(J({ path: p1, status: r1.status }));
      if (r1.status === 200) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(r1.body);
        } catch {
          console.log(`unparseable body (first 1000): ${r1.body.slice(0, 1000)}`);
        }
        const trips = parsed?.trips ?? parsed?.data ?? [];
        console.log(`tripCount: ${Array.isArray(trips) ? trips.length : 0}`);
        for (const t of Array.isArray(trips) ? trips : []) {
          console.log(J({
            startLocal: localTime(Number(t.startMs ?? Date.parse(t.startTime ?? ""))),
            endLocal: localTime(Number(t.endMs ?? Date.parse(t.endTime ?? ""))),
            startAddress: t.startLocation ?? t.startAddress ?? t.startCoordinates ?? null,
            endAddress: t.endLocation ?? t.endAddress ?? t.endCoordinates ?? null,
            distanceMeters: t.distanceMeters ?? t.distanceMiles ?? null,
            driverId: t.driverId ?? t.driver?.id ?? null,
            driverName: t.driverName ?? t.driver?.name ?? null,
          }));
        }
      } else {
        console.log(`body (first 1000): ${r1.body.slice(0, 1000)}`);
        const p2 = `/v1/fleet/vehicles/${veh.id}/trips?startMs=${startMs}&endMs=${endMs}`;
        const r2 = await rawGet(p2);
        console.log(J({ path: p2, status: r2.status }));
        console.log(`body (first 1000): ${r2.body.slice(0, 1000)}`);
      }
    }
  }

  console.log(`\n\n=== (e) DJ JOHNSON ${DJ} RAW HOS ENTRIES — 2026-08-21 (compact) ===`);
  const s = localMidnight("2026-08-21");
  const e = localMidnight("2026-08-22");
  try {
    const logs = await rawHosLogs(s, e, DJ);
    console.log(`entryCount: ${logs.length}`);
    for (const l of logs) {
      const loc = l.logRecordedLocation ?? {};
      console.log(J({
        startLocal: localTime(Date.parse(l.logStartTime ?? "")),
        endLocal: localTime(Date.parse(l.logEndTime ?? "")),
        hosStatusType: l.hosStatusType ?? null,
        vehicleId: l.vehicle?.id != null ? String(l.vehicle.id) : "none",
        latitude: loc.latitude ?? null,
        longitude: loc.longitude ?? null,
        remark: l.remark ?? loc.formattedLocation ?? null,
      }));
    }
  } catch (err: any) {
    console.log(`ERROR: ${err?.message ?? err}`);
  }
}

await main();
