// Synthetic Samsara for the resumable-sweep tests: behaves like the real
// fetchers (window clipping, per-vehicle GPS) over fixture data. No network.
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Seg = { driverId: string; driverName: string | null; status: string; startMs: number; endMs: number; latitude: number | null; longitude: number | null; vehicleId: string | null; remark?: string | null };
type Gps = { vehicleId: string; timeMs: number; latitude: number; longitude: number };
type Assign = { driverId: string; driverName: string | null; vehicleId: string; vehicleName: string | null; startMs: number; endMs: number | null; assignmentType: string | null };

export const samsara = {
  drivers: [] as any[],
  addresses: [] as any[],
  segments: [] as Seg[],
  gps: [] as Gps[],
  assignments: [] as Assign[],
  calls: 0,
};

const load = (f: string) => JSON.parse(readFileSync(join(__dirname, f), "utf8"));
const WEEK = 7 * 86_400_000;

/** Week of 2026-09-21 built from the real fixtures (+ one synthetic backfill driver). */
export function loadWeek(opts: { small?: boolean } = {}) {
  const files: Array<[string, number]> = opts.small
    ? [["outler-2026-09-21.json", 0]]
    : [
        ["outler-2026-09-21.json", 0],
        ["outler-2026-09-22.json", 0],
        ["outler-2026-09-24.json", 0],
        ["farahkhan-2026-09-16.json", WEEK],
        ["mcginnis-2026-09-11.json", 2 * WEEK],
      ];
  const drivers = new Map<string, any>();
  const fences = new Map<string, any>();
  const segments: Seg[] = [];
  const gps: Gps[] = [];
  const seenGps = new Set<string>();
  for (const [f, shift] of files) {
    const fx = load(f);
    const id = String(fx.driver.id);
    drivers.set(id, {
      id,
      name: fx.driver.name,
      driverActivationStatus: "active",
      eldDayStartHour: 0,
      timezone: fx.tzOffsetMinutes === -240 ? "America/New_York" : "America/Chicago",
      tags: fx.tags ?? [],
      licenseNumber: "L-TEST",
      licenseState: "TX",
      username: null,
    });
    for (const fe of fx.fences) fences.set(String(fe.id), fe);
    for (const s of fx.segments)
      segments.push({ ...s, driverId: id, driverName: fx.driver.name, startMs: s.startMs + shift, endMs: s.endMs + shift, vehicleId: s.vehicleId ?? null });
    for (const g of fx.gps) {
      const row = { vehicleId: String(g.vehicleId), timeMs: g.timeMs + shift, latitude: g.latitude, longitude: g.longitude };
      const k = `${row.vehicleId}|${row.timeMs}|${row.latitude}|${row.longitude}`;
      if (seenGps.has(k)) continue; // fixtures for consecutive days share boundary samples
      seenGps.add(k);
      gps.push(row);
    }
  }
  // Synthetic driver: blank vehicles on the log, filled from assignments, GPS at the first fence.
  const fence = [...fences.values()][0];
  const pt = fence.circle
    ? { latitude: fence.circle.latitude, longitude: fence.circle.longitude }
    : fence.polygon[0];
  const base = Date.parse("2026-09-23T13:00:00Z");
  const syn = "syn-1";
  drivers.set(syn, { id: syn, name: "Sam Synthetic", driverActivationStatus: "active", eldDayStartHour: 0, timezone: "America/Chicago", tags: [], licenseNumber: "L-SYN", licenseState: "TX", username: null });
  const H = 3_600_000;
  segments.push(
    { driverId: syn, driverName: "Sam Synthetic", status: "onDuty", startMs: base, endMs: base + 3 * H, latitude: null, longitude: null, vehicleId: null },
    { driverId: syn, driverName: "Sam Synthetic", status: "driving", startMs: base + 3 * H, endMs: base + 4 * H, latitude: null, longitude: null, vehicleId: null },
    { driverId: syn, driverName: "Sam Synthetic", status: "onDuty", startMs: base + 4 * H, endMs: base + 6 * H, latitude: null, longitude: null, vehicleId: null },
  );
  for (let t = base - H; t < base + 7 * H; t += 60_000) {
    gps.push({ vehicleId: "veh-syn", timeMs: t, latitude: pt.latitude, longitude: pt.longitude });
    if (t % (5 * 60_000) === 0) gps.push({ vehicleId: "veh-syn", timeMs: t, latitude: pt.latitude, longitude: pt.longitude }); // Samsara duplicate
  }
  const assignments: Assign[] = [
    { driverId: syn, driverName: "Sam Synthetic", vehicleId: "veh-syn", vehicleName: null, startMs: base - H, endMs: base + 7 * H, assignmentType: "HOS" },
  ];
  // Unlicensed known driver: excluded from the roster, still retirable.
  drivers.set("nolic-1", { id: "nolic-1", name: "Dallas Warehouse Login", driverActivationStatus: "active", eldDayStartHour: 0, timezone: null, tags: [], licenseNumber: null, licenseState: null, username: null });

  samsara.drivers = [...drivers.values()];
  samsara.addresses = [...fences.values()].map((f) => ({ id: String(f.id), name: f.name, formattedAddress: null, tags: [], circle: f.circle ?? null, polygon: f.polygon ?? null }));
  samsara.segments = segments;
  samsara.gps = gps;
  samsara.assignments = assignments;
  samsara.calls = 0;
  return { fenceIds: samsara.addresses.map((a) => a.id) };
}

export const samsaraMock = {
  fetchDrivers: async () => (samsara.calls++, structuredClone(samsara.drivers)),
  fetchAddresses: async () => (samsara.calls++, structuredClone(samsara.addresses)),
  fetchHosLogs: async (o: { startMs: number; endMs: number; driverIds: string[] }) => {
    samsara.calls++;
    const end = Math.min(o.endMs, Date.now());
    const ids = new Set(o.driverIds);
    return samsara.segments
      .filter((s) => ids.has(s.driverId) && s.endMs > o.startMs && s.startMs < end)
      .map((s) => ({ ...s, startMs: Math.max(s.startMs, o.startMs), endMs: Math.min(s.endMs, end) }))
      .filter((s) => s.endMs > s.startMs);
  },
  fetchDriverVehicleAssignments: async (o: { startMs: number; endMs: number; driverIds: string[] }) => {
    samsara.calls++;
    const ids = new Set(o.driverIds);
    return samsara.assignments.filter((a) => ids.has(a.driverId) && (a.endMs ?? Infinity) > o.startMs && a.startMs < o.endMs).map((a) => ({ ...a }));
  },
  fetchVehicleGpsHistory: async (o: { startMs: number; endMs: number; vehicleIds: string[] }) => {
    samsara.calls++;
    const end = Math.min(o.endMs, Date.now());
    const ids = new Set(o.vehicleIds);
    return samsara.gps.filter((g) => ids.has(g.vehicleId) && g.timeMs >= o.startMs && g.timeMs <= end).map((g) => ({ ...g }));
  },
  fetchDailyLogs: async () => [],
};
