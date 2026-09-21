// READ-ONLY Samsara evidence probe #2 — DJ Johnson (53243889).
// Calls Samsara directly (no cache layer, no DB writes).
import { samsaraApi, samsaraPaged, fetchAddresses } from "../src/lib/samsara/hos.server";
import { getDriverTimeSettings } from "../src/lib/driver-time.server";
import { haversineMeters, pointInGeofence, type Geofence, type LatLon } from "../src/lib/driver-time/geo";
import { tzOffsetMinutesAt } from "../src/lib/tz";

const MINUTE = 60_000;
const CT = "America/Chicago";
const DJ = "53243889";
const SHARED = [
  { id: "53244597", name: "Dallas Warehouse" },
  { id: "53244760", name: "Dallas LTL" },
  { id: "53332924", name: "Scott Smith" },
];
const VEHICLE = "281474996579824"; // unit 443627
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

function J(v: unknown) {
  return JSON.stringify(v, null, 2);
}

/** Raw HOS log entries, verbatim. */
async function rawHosLogs(startMs: number, endMs: number, driverId: string): Promise<any[]> {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    driverIds: driverId,
  });
  const rows = await samsaraPaged<any>(`/fleet/hos/logs?${params.toString()}`, (d) => d.data ?? []);
  const out: any[] = [];
  for (const row of rows) {
    const logs = row.hosLogs ?? row.logs ?? [];
    for (const l of logs) out.push({ driver: row.driver ?? null, log: l });
  }
  return out;
}

/** Raw daily-log rows, verbatim. */
async function rawDailyLogs(date: string, driverId: string): Promise<any[]> {
  const params = new URLSearchParams({ startDate: date, endDate: date, driverIds: driverId });
  return samsaraPaged<any>(`/fleet/hos/daily-logs?${params.toString()}`, (d) => d.data ?? []);
}

async function rawAssignmentsByVehicle(startMs: number, endMs: number, vehicleId: string): Promise<any[]> {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    filterBy: "vehicles",
    vehicleIds: vehicleId,
  });
  return samsaraPaged<any>(`/fleet/driver-vehicle-assignments?${params.toString()}`, (d) => d.data ?? []);
}

async function vehicleStatsHistory(startMs: number, endMs: number, vehicleId: string): Promise<any[]> {
  const params = new URLSearchParams({
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(Math.min(endMs, Date.now())).toISOString(),
    types: "engineStates,gps",
    ids: vehicleId,
  });
  return samsaraPaged<any>(`/fleet/vehicles/stats/history?${params.toString()}`, (d) => d.data ?? []);
}

/** Bare fetch so status codes and raw bodies can be printed for item 8. */
async function rawProbe(path: string): Promise<void> {
  const url = `https://api.samsara.com${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.SAMSARA_API_TOKEN ?? ""}`,
        Accept: "application/json",
      },
    });
    const body = await res.text().catch(() => "");
    console.log(`PROBE ${path}`);
    console.log(`status: ${res.status} ${res.statusText}`);
    console.log(`body (first 3000 chars): ${body.slice(0, 3000)}`);
  } catch (e: any) {
    console.log(`PROBE ${path}`);
    console.log(`status: fetch error`);
    console.log(`body: ${e?.message ?? e}`);
  }
}

function distanceToFence(p: LatLon, fence: Geofence): number | null {
  if (pointInGeofence(p, fence)) return 0;
  if (fence.circle) return Math.max(0, haversineMeters(p, fence.circle) - fence.circle.radiusMeters);
  if (fence.polygon?.length) return Math.min(...fence.polygon.map((v) => haversineMeters(p, v)));
  return null;
}

function insideRanges(
  samples: Array<{ timeMs: number; latitude: number; longitude: number }>,
  fences: Geofence[],
) {
  const ranges: Array<Record<string, unknown>> = [];
  let cur: { fence: string; startMs: number; endMs: number; samples: number } | null = null;
  for (const s of samples) {
    const hit = fences.find((f) => pointInGeofence(s, f)) ?? null;
    if (hit && cur && cur.fence === hit.name) {
      cur.endMs = s.timeMs;
      cur.samples += 1;
      continue;
    }
    if (cur) {
      ranges.push({
        fence: cur.fence,
        startLocal: localTime(cur.startMs),
        endLocal: localTime(cur.endMs),
        durationMin: Math.round(((cur.endMs - cur.startMs) / MINUTE) * 10) / 10,
        samples: cur.samples,
      });
      cur = null;
    }
    if (hit) cur = { fence: hit.name, startMs: s.timeMs, endMs: s.timeMs, samples: 1 };
  }
  if (cur) {
    ranges.push({
      fence: cur.fence,
      startLocal: localTime(cur.startMs),
      endLocal: localTime(cur.endMs),
      durationMin: Math.round(((cur.endMs - cur.startMs) / MINUTE) * 10) / 10,
      samples: cur.samples,
    });
  }
  return ranges;
}

async function main() {
  const settings = await getDriverTimeSettings();
  const addresses = await fetchAddresses();
  const allFences: Geofence[] = addresses
    .filter((a) => settings.warehouseAddressIds.includes(a.id))
    .map((a) => ({ id: a.id, name: a.name, circle: a.circle, polygon: a.polygon }));
  const dallasFences = allFences.filter((f) => /dallas/i.test(f.name));

  console.log("=== SELECTED WAREHOUSE GEOFENCES ===");
  console.log(J(allFences));
  console.log("=== DALLAS FENCES USED FOR INSIDE-RANGE TESTS ===");
  console.log(J(dallasFences.map((f) => ({ id: f.id, name: f.name }))));

  for (const date of DATES) {
    const startMs = localMidnight(date);
    const endMs = localMidnight(addDays(date, 1));
    console.log(`\n\n########## DATE ${date} (CT window ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()}) ##########`);

    // (1)/(6) DJ raw HOS entries
    console.log(`\n=== (1) RAW HOS LOG ENTRIES — DJ Johnson ${DJ} — ${date} ===`);
    try {
      const rows = await rawHosLogs(startMs, endMs, DJ);
      console.log(`entryCount: ${rows.length}`);
      for (const r of rows) {
        console.log(J({
          driver: r.driver,
          localStart: localTime(Date.parse(r.log.logStartTime ?? "")),
          localEnd: localTime(Date.parse(r.log.logEndTime ?? "")),
          raw: r.log,
        }));
      }
    } catch (e: any) {
      console.log(`ERROR: ${e?.message ?? e}`);
    }

    if (date === "2026-09-11") {
      // (2) DJ daily log
      console.log(`\n=== (2) RAW DAILY LOG — DJ Johnson ${DJ} — ${date} ===`);
      try {
        console.log(J(await rawDailyLogs(date, DJ)));
      } catch (e: any) {
        console.log(`ERROR: ${e?.message ?? e}`);
      }

      // (3) shared logins + Scott Smith
      for (const s of SHARED) {
        console.log(`\n=== (3) RAW HOS LOG ENTRIES — ${s.name} ${s.id} — ${date} ===`);
        try {
          const rows = await rawHosLogs(startMs, endMs, s.id);
          console.log(`entryCount: ${rows.length}`);
          for (const r of rows) {
            console.log(J({
              driver: r.driver,
              localStart: localTime(Date.parse(r.log.logStartTime ?? "")),
              localEnd: localTime(Date.parse(r.log.logEndTime ?? "")),
              raw: r.log,
            }));
          }
        } catch (e: any) {
          console.log(`ERROR: ${e?.message ?? e}`);
        }
        console.log(`\n=== (3) RAW DAILY LOG — ${s.name} ${s.id} — ${date} ===`);
        try {
          console.log(J(await rawDailyLogs(date, s.id)));
        } catch (e: any) {
          console.log(`ERROR: ${e?.message ?? e}`);
        }
      }
    }

    // (4)/(6) assignments by vehicle
    console.log(`\n=== (4) DRIVER-VEHICLE ASSIGNMENTS — VEHICLE ${VEHICLE} — ${date} (filterBy=vehicles) ===`);
    try {
      const rows = await rawAssignmentsByVehicle(startMs, endMs, VEHICLE);
      console.log(`rawRowCount: ${rows.length}`);
      console.log("RAW:");
      console.log(J(rows));
      console.log("FLATTENED:");
      for (const row of rows) {
        const list = Array.isArray(row.assignments) ? row.assignments : [row];
        for (const a of list) {
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
    } catch (e: any) {
      console.log(`ERROR: ${e?.message ?? e}`);
    }

    // (5)/(6) vehicle stats history
    console.log(`\n=== (5) VEHICLE ${VEHICLE} STATS HISTORY (engineStates,gps) — ${date} ===`);
    try {
      const rows = await vehicleStatsHistory(startMs, endMs, VEHICLE);
      const engine: Array<{ timeMs: number; value: string }> = [];
      const gps: Array<{ timeMs: number; latitude: number; longitude: number }> = [];
      for (const v of rows) {
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

      console.log(`engineStateCount: ${engine.length}`);
      console.log("ENGINE STATE TRANSITIONS:");
      let prev: string | null = null;
      for (const e of engine) {
        if (e.value === prev) continue;
        console.log(J({ localTime: localTime(e.timeMs), value: e.value }));
        prev = e.value;
      }

      console.log(`gpsSampleCount: ${gps.length}`);
      console.log(J({
        firstSampleLocal: gps.length ? localTime(gps[0].timeMs) : null,
        lastSampleLocal: gps.length ? localTime(gps[gps.length - 1].timeMs) : null,
      }));
      console.log("INSIDE DALLAS FENCE RANGES:");
      const ranges = insideRanges(gps, dallasFences);
      if (!ranges.length) console.log("none");
      for (const r of ranges) console.log(J(r));

      console.log("INSIDE ANY SELECTED FENCE RANGES:");
      const anyRanges = insideRanges(gps, allFences);
      if (!anyRanges.length) console.log("none");
      for (const r of anyRanges) console.log(J(r));

      // Nearest-fence context for the first/last sample of the day.
      for (const label of ["first", "last"] as const) {
        const s = label === "first" ? gps[0] : gps[gps.length - 1];
        if (!s) continue;
        const near = allFences
          .map((f) => ({ name: f.name, meters: distanceToFence(s, f) }))
          .filter((x) => x.meters !== null)
          .sort((a, b) => (a.meters as number) - (b.meters as number))[0];
        console.log(J({ sample: label, localTime: localTime(s.timeMs), nearestFence: near?.name ?? null, meters: near ? Math.round(near.meters as number) : null }));
      }
    } catch (e: any) {
      console.log(`ERROR: ${e?.message ?? e}`);
    }
  }

  // (7) clocks
  console.log(`\n\n=== (7) /fleet/hos/clocks?driverIds=${DJ} ===`);
  await rawProbe(`/fleet/hos/clocks?driverIds=${DJ}`);

  // (8) alternate endpoints
  console.log(`\n\n=== (8) ALTERNATE ENDPOINT PROBES ===`);
  console.log(`\n--- /fleet/drivers/${DJ} (licenseNumber redacted below) ---`);
  try {
    const res = await samsaraApi<any>(`/fleet/drivers/${DJ}`);
    const data = res?.data ?? res;
    if (data && typeof data === "object" && "licenseNumber" in data) {
      data.licenseNumber = data.licenseNumber ? "present" : null;
    }
    console.log("status: 200");
    console.log(J(res));
  } catch (e: any) {
    console.log(`ERROR: ${e?.message ?? e}`);
  }
  await rawProbe(`/fleet/drivers/${DJ}/hos/daily-logs?startDate=2026-09-11&endDate=2026-09-11`);
  const s = localMidnight("2026-09-11");
  const e = localMidnight("2026-09-12");
  await rawProbe(`/v1/fleet/drivers/${DJ}/hos_daily_logs?startMs=${s}&endMs=${e}`);
}

await main();
