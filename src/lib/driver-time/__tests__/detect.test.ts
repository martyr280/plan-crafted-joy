import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { detectWarehouseEvents, eldDayBoundaries, isExcludedDriver, localDateKey, type HosSegment } from "../detect";
import type { Geofence } from "../geo";

// Birmingham warehouse geofence, 300 m circle.
const WH: Geofence = {
  id: "addr-bhm",
  name: "Birmingham Warehouse Yard",
  hub: "Birmingham",
  circle: { latitude: 33.5186, longitude: -86.8104, radiusMeters: 300 },
};
const AT_WH = { latitude: 33.5186, longitude: -86.8104 };
const ELSEWHERE = { latitude: 34.5, longitude: -86.0 };

const CST = -360; // minutes offset from UTC
/** Local CST wall clock -> epoch ms. */
function cst(day: number, hour: number, minute = 0): number {
  return Date.UTC(2026, 7, day, hour, minute) - CST * 60_000;
}

function seg(partial: Partial<HosSegment> & { startMs: number; endMs: number; status: string }): HosSegment {
  return {
    driverId: "d1",
    driverName: "Ray Driver",
    vehicleId: "v1",
    latitude: AT_WH.latitude,
    longitude: AT_WH.longitude,
    ...partial,
  } as HosSegment;
}

const driver = { id: "d1", name: "Ray Driver" };
const OPTS = { tzOffsetMinutes: CST, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10, basis: "onduty" as const };

function run(segments: HosSegment[], extra: Record<string, unknown> = {}, gpsSamples: any[] = []) {
  return detectWarehouseEvents({
    driver,
    segments,
    warehouses: [WH],
    gpsSamples,
    options: { ...OPTS, ...extra },
  });
}

describe("eldDayBoundaries", () => {
  it("returns nothing for a block inside one day", () => {
    expect(eldDayBoundaries(cst(5, 8), cst(5, 14), 0, CST)).toEqual([]);
  });
  it("returns the midnight boundary for a block that straddles it", () => {
    const bounds = eldDayBoundaries(cst(5, 22), cst(6, 2), 0, CST);
    expect(bounds).toEqual([cst(6, 0)]);
  });
  it("honours a non-midnight ELD day start", () => {
    expect(eldDayBoundaries(cst(5, 2), cst(5, 6), 4, CST)).toEqual([cst(5, 4)]);
  });
});

describe("localDateKey", () => {
  it("uses the driver's local offset, not UTC", () => {
    // 2026-08-05 23:00 CST is 2026-08-06 05:00 UTC
    expect(localDateKey(cst(5, 23), CST)).toBe("2026-08-05");
  });
});

describe("detectWarehouseEvents — golden fixtures", () => {
  it("6-minute stop is not flagged", () => {
    expect(run([seg({ startMs: cst(5, 9), endMs: cst(5, 9, 6), status: "onDuty" })])).toHaveLength(0);
  });

  it("59-minute stop is not flagged", () => {
    expect(run([seg({ startMs: cst(5, 9), endMs: cst(5, 9, 59), status: "onDuty" })])).toHaveLength(0);
  });

  it("89 or exactly 90 minutes is not flagged; 91 minutes is", () => {
    expect(run([seg({ startMs: cst(5, 9), endMs: cst(5, 10, 29), status: "onDuty" })])).toHaveLength(0);
    expect(run([seg({ startMs: cst(5, 9), endMs: cst(5, 10, 30), status: "onDuty" })])).toHaveLength(0);
    const ninetyOne = run([seg({ startMs: cst(5, 9), endMs: cst(5, 10, 31), status: "onDuty" })]);
    expect(ninetyOne).toHaveLength(1);
    expect(ninetyOne[0].durationMin).toBe(91);
  });

  it("8:04am–2:52pm becomes one 6h48m event", () => {
    const events = run([
      seg({ startMs: cst(5, 8, 4), endMs: cst(5, 11), status: "onDuty" }),
      seg({ startMs: cst(5, 11), endMs: cst(5, 14, 52), status: "yardMove" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(6 * 60 + 48);
    expect(events[0].statuses).toEqual(["onDuty", "yardMove"]);
    expect(events[0].addressName).toBe(WH.name);
    expect(events[0].locationSource).toBe("log");
  });

  it("3h morning + 2h afternoon on the same day are TWO events", () => {
    const events = run([
      seg({ startMs: cst(5, 7), endMs: cst(5, 10), status: "onDuty" }),
      seg({ startMs: cst(5, 10), endMs: cst(5, 13), status: "driving", latitude: null, longitude: null }),
      seg({ startMs: cst(5, 13), endMs: cst(5, 15), status: "onDuty" }),
    ]);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.durationMin)).toEqual([180, 120]);
    expect(new Set(events.map((e) => e.eventDate)).size).toBe(1);
  });

  it("merges two blocks split by a 5-minute move inside the same geofence", () => {
    const events = run([
      seg({ startMs: cst(5, 7), endMs: cst(5, 8), status: "onDuty" }),
      seg({ startMs: cst(5, 8), endMs: cst(5, 8, 5), status: "driving", latitude: null, longitude: null }),
      seg({ startMs: cst(5, 8, 5), endMs: cst(5, 9, 30), status: "onDuty" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(150);
  });

  it("does not flag a long block away from any warehouse", () => {
    const events = run([
      seg({ startMs: cst(5, 8), endMs: cst(5, 14), status: "onDuty", ...ELSEWHERE }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("splits a block that straddles the ELD day boundary", () => {
    const events = run(
      [seg({ startMs: cst(5, 22), endMs: cst(6, 2), status: "onDuty" })],
      {},
      [{ vehicleId: "v1", timeMs: cst(6, 0), latitude: AT_WH.latitude, longitude: AT_WH.longitude }],
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.eventDate)).toEqual(["2026-08-05", "2026-08-06"]);
    expect(events.map((e) => e.durationMin)).toEqual([120, 120]);
    expect(events[1].locationSource).toBe("vehicle_gps");
  });

  it("falls back to vehicle GPS when the log carries no location", () => {
    const events = run(
      [seg({ startMs: cst(5, 8), endMs: cst(5, 12), status: "onDuty", latitude: null, longitude: null })],
      {},
      [{ vehicleId: "v1", timeMs: cst(5, 8, 5), latitude: AT_WH.latitude, longitude: AT_WH.longitude }],
    );
    expect(events).toHaveLength(1);
    expect(events[0].locationSource).toBe("vehicle_gps");
    expect(events[0].needsReview).toBe(false);
    expect(events[0].addressId).toBe(WH.id);
  });

  it("never drops an unlocatable long block — flags it for review", () => {
    const events = run([
      seg({ startMs: cst(5, 8), endMs: cst(5, 12), status: "onDuty", latitude: null, longitude: null }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].locationSource).toBe("unknown");
    expect(events[0].needsReview).toBe(true);
    expect(events[0].addressId).toBeNull();
  });

  it("ignores off-duty and sleeper time", () => {
    const events = run([
      seg({ startMs: cst(5, 1), endMs: cst(5, 7), status: "sleeperBerth" }),
      seg({ startMs: cst(5, 7), endMs: cst(5, 8), status: "offDuty" }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("respects a custom threshold", () => {
    const events = run([seg({ startMs: cst(5, 9), endMs: cst(5, 10), status: "onDuty" })], { thresholdMinutes: 45 });
    expect(events).toHaveLength(1);
  });
});

describe("driver exclusions", () => {
  const opts = { excludedDriverNamePatterns: ["Birmingham LTL", "Birmingham Warehouse"], excludedDriverIds: ["bot-1"] };

  it("matches the seeded non-human accounts", () => {
    expect(isExcludedDriver({ id: "x", name: "Birmingham LTL" }, opts)).toBe(true);
    expect(isExcludedDriver({ id: "y", name: "birmingham warehouse 2" }, opts)).toBe(true);
    expect(isExcludedDriver({ id: "bot-1", name: "Whoever" }, opts)).toBe(true);
    expect(isExcludedDriver({ id: "z", name: "Ray Driver" }, opts)).toBe(false);
  });

  it("produces zero events for an excluded account", () => {
    const events = detectWarehouseEvents({
      driver: { id: "d1", name: "Birmingham Warehouse" },
      segments: [seg({ startMs: cst(5, 8), endMs: cst(5, 16), status: "onDuty" })],
      warehouses: [WH],
      options: { ...OPTS, ...opts },
    });
    expect(events).toHaveLength(0);
  });
});

describe("midnight / parked-truck artifact (2026-09-29)", () => {
  // Dallas yard; DJ Johnson 53243889, truck 281474996579825. CDT = UTC-5.
  const DAL: Geofence = { id: "addr-dal", name: "Dallas Warehouse", hub: "Dallas", circle: { latitude: 32.8119, longitude: -96.878, radiusMeters: 300 } };
  const V = "281474996579825";
  const z = (iso: string) => Date.parse(iso);
  const P = { tzOffsetMinutes: -300, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10, basis: "presence" as const };
  const dj = (s: string, e: string, status: string, own: { lat: number; lon: number } | null): HosSegment => ({
    driverId: "53243889", driverName: "DJ Johnson", status, startMs: z(s), endMs: z(e),
    latitude: own?.lat ?? null, longitude: own?.lon ?? null,
    vehicleId: V, vehicleBackfilled: own === null,
  } as HosSegment);
  // Truck parked in the fence all night: a GPS ping every 10 min 05:00Z–13:00Z.
  const parkedGps = Array.from({ length: 49 }, (_, i) => ({ vehicleId: V, timeMs: z("2026-09-21T05:00:00Z") + i * 600_000, latitude: 32.8119, longitude: -96.878 }));
  const detect = (segments: HosSegment[], gps = parkedGps) =>
    detectWarehouseEvents({ driver: { id: "53243889", name: "DJ Johnson" }, segments, warehouses: [DAL], gpsSamples: gps, options: P });

  it("DJ 9/21 raw rows: no block before 12:49Z, no 00:00–07:19 Central time", () => {
    const events = detect([
      dj("2026-09-21T05:00:00Z", "2026-09-21T12:19:00Z", "offDuty", null),
      dj("2026-09-21T12:19:00Z", "2026-09-21T12:49:00Z", "offDuty", null),
      dj("2026-09-21T12:49:00Z", "2026-09-21T12:56:00Z", "onDuty", null),
      dj("2026-09-21T12:56:00Z", "2026-09-21T12:57:01.586Z", "driving", null),
      dj("2026-09-21T12:57:01.586Z", "2026-09-21T13:20:55.013Z", "driving", { lat: 32.811877, lon: -96.878054 }),
      dj("2026-09-21T13:20:55.013Z", "2026-09-21T16:35:00Z", "driving", { lat: 32.811246, lon: -96.877954 }),
      dj("2026-09-21T16:35:00Z", "2026-09-21T16:35:05Z", "driving", { lat: 33.4519, lon: -94.11086 }),
      dj("2026-09-21T16:35:05Z", "2026-09-21T16:39:07Z", "driving", { lat: 33.451787, lon: -94.109375 }),
    ]);
    expect(events.filter((e) => e.startMs < z("2026-09-21T12:49:00Z"))).toHaveLength(0);
    expect(events.filter((e) => e.startMs < z("2026-09-21T12:19:00Z") && e.endMs > z("2026-09-21T05:00:00Z"))).toHaveLength(0);
  });

  it("truck parked in the fence overnight, driver offDuty/sleeperBerth with vehicle 0 → 0 minutes", () => {
    const events = detect([
      dj("2026-09-21T05:00:00Z", "2026-09-21T09:00:00Z", "sleeperBerth", null),
      dj("2026-09-21T09:00:00Z", "2026-09-21T12:40:00Z", "offDuty", null),
      dj("2026-09-21T12:40:00Z", "2026-09-21T12:45:00Z", "onDuty", { lat: 34.5, lon: -86.0 }),
    ]);
    expect(events.reduce((n, e) => n + e.durationMin, 0)).toBe(0);
  });

  it("real overnight block on the driver's own vehicle 22:00–02:00 is counted and split", () => {
    const at = { lat: 32.8119, lon: -96.878 };
    const events = detect([
      dj("2026-09-21T03:00:00Z", "2026-09-21T07:00:00Z", "onDuty", at), // 9/20 22:00 → 9/21 02:00 CDT
    ], [{ vehicleId: V, timeMs: z("2026-09-21T05:00:00Z"), latitude: 32.8119, longitude: -96.878 }]);
    expect(events.map((e) => [e.eventDate, e.durationMin])).toEqual([["2026-09-20", 120], ["2026-09-21", 120]]);
  });
});

describe("backfilled truck places a WORKING driver (correction to 7931ba0)", () => {
  const DAL: Geofence = { id: "addr-dal", name: "Dallas Warehouse", hub: "Dallas", circle: { latitude: 32.8119, longitude: -96.878, radiusMeters: 300 } };
  const z = (iso: string) => Date.parse(iso);
  it("backfilled onDuty 08:00–16:00 in the fence with truck GPS in the fence → 480 min", () => {
    const gps = Array.from({ length: 49 }, (_, i) => ({ vehicleId: "v9", timeMs: z("2026-09-22T13:00:00Z") + i * 600_000, latitude: 32.8119, longitude: -96.878 }));
    const events = detectWarehouseEvents({
      driver: { id: "d9", name: "Yard Worker" },
      segments: [{ driverId: "d9", driverName: "Yard Worker", status: "onDuty", startMs: z("2026-09-22T13:00:00Z"), endMs: z("2026-09-22T21:00:00Z"), latitude: null, longitude: null, vehicleId: "v9", vehicleBackfilled: true } as HosSegment],
      warehouses: [DAL], gpsSamples: gps,
      options: { tzOffsetMinutes: -300, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10, basis: "presence" },
    });
    expect(events.map((e) => e.durationMin)).toEqual([480]);
  });
});

describe("regressions from cached Samsara hos_logs (Joe Green's sheets)", () => {
  const load = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8"));
  const run = (fx: any, date: string) =>
    detectWarehouseEvents({
      driver: fx.driver, segments: fx.segments, warehouses: fx.fences, gpsSamples: fx.gps,
      options: { tzOffsetMinutes: fx.tzOffsetMinutes, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10, basis: "presence", hubTags: fx.tags },
    }).filter((e) => e.eventDate === date);
  const total = (ev: { durationMin: number }[]) => ev.reduce((n, e) => n + e.durationMin, 0);
  it("Joseph Outler 9/10 → 497 ±2", () => expect(Math.abs(total(run(load("outler-2026-09-10.json"), "2026-09-10")) - 497)).toBeLessThanOrEqual(2));
  it("Joseph Outler 9/17 → 444 ±2", () => expect(Math.abs(total(run(load("outler-2026-09-17.json"), "2026-09-17")) - 444)).toBeLessThanOrEqual(2));
  it("Karriem Farahkhan 9/16 → 426 ±2", () => expect(Math.abs(total(run(load("farahkhan-2026-09-16.json"), "2026-09-16")) - 426)).toBeLessThanOrEqual(2));
});

describe("Joe Green answers 2026-09-30: warehouse remark (A) and clock-out tail (B)", () => {
  const load = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8"));
  const day = (fx: any, date: string) =>
    detectWarehouseEvents({
      driver: fx.driver, segments: fx.segments, warehouses: fx.fences, gpsSamples: fx.gps,
      options: { tzOffsetMinutes: fx.tzOffsetMinutes, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10, basis: "presence", hubTags: fx.tags },
    }).filter((e) => e.eventDate === date);
  const total = (ev: { durationMin: number }[]) => ev.reduce((n, e) => n + e.durationMin, 0);

  it("A: Outler 9/21 'Warehouse' remark → 517 ±5, one remark event", () => {
    const ev = day(load("outler-2026-09-21.json"), "2026-09-21");
    expect(Math.abs(total(ev) - 517)).toBeLessThanOrEqual(5);
    expect(ev.map((e) => e.locationSource)).toEqual(["remark"]);
    expect(ev[0].notes).toMatch(/Warehouse/);
  });
  it("A: Outler 9/22 'Warehouse' remark → 506 ±5", () => {
    expect(Math.abs(total(day(load("outler-2026-09-22.json"), "2026-09-22")) - 506)).toBeLessThanOrEqual(5);
  });
  it("B: Outler 9/24 fuel stop before clock-out → 186 ±3", () => {
    expect(Math.abs(total(day(load("outler-2026-09-24.json"), "2026-09-24")) - 186)).toBeLessThanOrEqual(3);
  });
  it("A: remark on a synthetic day spans first work → last clock-out", () => {
    const ev = run([
      seg({ startMs: cst(5, 7), endMs: cst(5, 9), status: "onDuty", latitude: null, longitude: null, remark: "warehouse " } as any),
      seg({ startMs: cst(5, 9), endMs: cst(5, 12), status: "driving", ...ELSEWHERE }),
      seg({ startMs: cst(5, 12), endMs: cst(5, 15), status: "onDuty", ...ELSEWHERE }),
      seg({ startMs: cst(5, 15), endMs: cst(5, 23), status: "offDuty", ...ELSEWHERE }),
    ], { basis: "presence" });
    expect(ev.map((e) => [e.durationMin, e.locationSource])).toEqual([[480, "remark"]]);
  });
  it("B: a work stop within 30 min of leaving the fence is added; driving alone is not", () => {
    const tail = (stopStartMin: number) => run([
      seg({ startMs: cst(5, 8), endMs: cst(5, 12), status: "onDuty" }),
      seg({ startMs: cst(5, 12), endMs: cst(5, 12, stopStartMin), status: "driving", ...ELSEWHERE }),
      seg({ startMs: cst(5, 12, stopStartMin), endMs: cst(5, 12, stopStartMin + 15), status: "onDuty", ...ELSEWHERE }),
      seg({ startMs: cst(5, 12, stopStartMin + 15), endMs: cst(5, 14), status: "driving", ...ELSEWHERE }),
      seg({ startMs: cst(5, 14), endMs: cst(5, 23), status: "offDuty", ...ELSEWHERE }),
    ], { basis: "presence" }).map((e) => e.durationMin);
    expect(tail(15)).toEqual([270]);
    expect(tail(40)).toEqual([240]);
    const driveOnly = run([
      seg({ startMs: cst(5, 8), endMs: cst(5, 12), status: "onDuty" }),
      seg({ startMs: cst(5, 12), endMs: cst(5, 12, 20), status: "driving", ...ELSEWHERE }),
      seg({ startMs: cst(5, 12, 20), endMs: cst(5, 20), status: "offDuty", ...ELSEWHERE }),
    ], { basis: "presence" });
    expect(driveOnly.map((e) => e.durationMin)).toEqual([240]);
  });
});
