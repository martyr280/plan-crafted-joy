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
const OPTS = { tzOffsetMinutes: CST, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10 };

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

  it("89 minutes is not flagged, 90 minutes is", () => {
    expect(run([seg({ startMs: cst(5, 9), endMs: cst(5, 10, 29), status: "onDuty" })])).toHaveLength(0);
    const ninety = run([seg({ startMs: cst(5, 9), endMs: cst(5, 10, 30), status: "onDuty" })]);
    expect(ninety).toHaveLength(1);
    expect(ninety[0].durationMin).toBe(90);
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
