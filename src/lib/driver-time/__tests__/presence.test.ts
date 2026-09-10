import { describe, expect, it } from "vitest";
import { detectWarehouseEvents, type HosSegment } from "../detect";
import type { Geofence } from "../geo";

// Fences approximate the real Samsara polygons (scripts/dt-probe-output-2026-09-10.txt)
// with a 400 m circle around their centre — every fixture point in the probe is
// either at the yard (0 m) or kilometres away, so the shape does not matter.
const OCALA: Geofence = { id: "290688696", name: "Ocala", hub: "Ocala", circle: { latitude: 29.18244, longitude: -82.21233, radiusMeters: 400 } };
const BHM: Geofence = { id: "290688247", name: "Birmingham", hub: "Birmingham", circle: { latitude: 33.63185, longitude: -86.736, radiusMeters: 400 } };
const DAL: Geofence = { id: "290688509", name: "Dallas", hub: "Dallas", circle: { latitude: 32.8110, longitude: -96.87795, radiusMeters: 400 } };
const FENCES = [OCALA, BHM, DAL];

const ET = -240; // America/New_York in August
const CT = -300; // America/Chicago in August

/** Local wall clock (August 2026) -> epoch ms for a fixed offset. */
function at(offsetMin: number, day: number, h: number, m = 0, s = 0): number {
  return Date.UTC(2026, 7, day, h, m, s) - offsetMin * 60_000;
}

type S = {
  status: string;
  startMs: number;
  endMs: number;
  latitude?: number | null;
  longitude?: number | null;
  vehicleId?: string | null;
};
function build(driverId: string, name: string, rows: S[]): HosSegment[] {
  return rows.map((r) => ({
    driverId,
    driverName: name,
    status: r.status,
    startMs: r.startMs,
    endMs: r.endMs,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    vehicleId: r.vehicleId ?? "0",
  }));
}

function run(
  driver: { id: string; name: string },
  segments: HosSegment[],
  extra: Record<string, unknown> = {},
) {
  return detectWarehouseEvents({
    driver,
    segments,
    warehouses: FENCES,
    options: { thresholdMinutes: 90, mergeGapMinutes: 10, eldDayStartHour: 0, tzOffsetMinutes: CT, ...extra },
  });
}

describe("presence basis — probe fixtures 2026-09-10", () => {
  it("Outler 2026-08-17 Ocala: overnight off-duty at the yard plus a 9-minute start is NOT an event", () => {
    const V = "281474996579837";
    const segs = build("53243882", "Joseph Outler", [
      { status: "offDuty", startMs: at(ET, 17, 0, 0), endMs: at(ET, 17, 16, 18, 1), latitude: 29.182442, longitude: -82.212332 },
      { status: "offDuty", startMs: at(ET, 17, 16, 18, 1), endMs: at(ET, 17, 16, 18, 25), latitude: 29.182274, longitude: -82.212689, vehicleId: V },
      { status: "onDuty", startMs: at(ET, 17, 16, 18, 25), endMs: at(ET, 17, 16, 27, 18), latitude: 29.182269, longitude: -82.212673, vehicleId: V },
      { status: "driving", startMs: at(ET, 17, 16, 27, 18), endMs: at(ET, 17, 16, 57, 18), latitude: 29.182513, longitude: -82.213958, vehicleId: V },
      { status: "onDuty", startMs: at(ET, 17, 16, 57, 18), endMs: at(ET, 17, 17, 6, 18), latitude: 29.091175, longitude: -82.243926, vehicleId: V },
      { status: "driving", startMs: at(ET, 17, 17, 6, 18), endMs: at(ET, 17, 17, 54, 22), latitude: 29.091074, longitude: -82.243638, vehicleId: V },
      { status: "onDuty", startMs: at(ET, 17, 17, 54, 22), endMs: at(ET, 17, 17, 55, 9), latitude: 28.872628, longitude: -82.546654, vehicleId: V },
      { status: "offDuty", startMs: at(ET, 17, 17, 55, 9), endMs: at(ET, 18, 0, 0), latitude: 28.872634, longitude: -82.546679 },
    ]);
    expect(run({ id: "53243882", name: "Joseph Outler" }, segs, { tzOffsetMinutes: ET })).toHaveLength(0);
  });

  it("Outler 2026-08-19 Ocala: on duty all day with no location and no vehicle is assumed home hub", () => {
    const segs = build("53243882", "Joseph Outler", [
      { status: "onDuty", startMs: at(ET, 19, 8, 3), endMs: at(ET, 19, 16, 49) },
    ]);
    const events = run({ id: "53243882", name: "Joseph Outler" }, segs, {
      tzOffsetMinutes: ET,
      hubTags: ["Ocala"],
    });
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(526);
    expect(events[0].hub).toBe("Ocala");
    expect(events[0].locationSource).toBe("assumed_hub");
    expect(events[0].needsReview).toBe(false);
    expect(events[0].eventDate).toBe("2026-08-19");
  });

  it("Loyd 2026-08-26 Birmingham: two on-duty hours 13 km from the yard is not warehouse time", () => {
    const V = "281474996579835";
    const segs = build("53243883", "Kennedy Loyd", [
      { status: "onDuty", startMs: at(CT, 26, 0, 0), endMs: at(CT, 26, 2, 0, 4), latitude: 33.522136, longitude: -86.797285, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 26, 2, 0, 4), endMs: at(CT, 26, 2, 3, 26), latitude: 33.522136, longitude: -86.797285, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 26, 2, 3, 26), endMs: at(CT, 27, 0, 0) },
    ]);
    expect(run({ id: "53243883", name: "Kennedy Loyd" }, segs, { hubTags: ["Birmingham"] })).toHaveLength(0);
  });

  it("Farahkhan 2026-08-28 Birmingham: 4 minutes at the yard then a drive-away is not an event", () => {
    const V = "281474996579838";
    const segs = build("53243880", "Karriem Farahkhan", [
      { status: "offDuty", startMs: at(CT, 28, 0, 0), endMs: at(CT, 28, 7, 18, 30), latitude: 33.631867, longitude: -86.736006 },
      { status: "offDuty", startMs: at(CT, 28, 7, 18, 30), endMs: at(CT, 28, 7, 18, 51), latitude: 33.631853, longitude: -86.735988, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 28, 7, 18, 51), endMs: at(CT, 28, 7, 22, 12), latitude: 33.631853, longitude: -86.735988, vehicleId: V },
      { status: "driving", startMs: at(CT, 28, 7, 22, 12), endMs: at(CT, 28, 7, 22, 54), latitude: 33.631797, longitude: -86.735906, vehicleId: V },
      { status: "driving", startMs: at(CT, 28, 7, 22, 54), endMs: at(CT, 28, 7, 38, 17), latitude: 33.631178, longitude: -86.736468, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 28, 7, 38, 17), endMs: at(CT, 28, 7, 41, 29), latitude: 33.564141, longitude: -86.784076, vehicleId: V },
      { status: "driving", startMs: at(CT, 28, 7, 41, 29), endMs: at(CT, 28, 7, 48, 3), latitude: 33.564095, longitude: -86.784517, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 28, 7, 48, 3), endMs: at(CT, 28, 7, 52, 26), latitude: 33.564345, longitude: -86.784015, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 28, 7, 52, 26), endMs: at(CT, 29, 0, 0) },
    ]);
    expect(run({ id: "53243880", name: "Karriem Farahkhan" }, segs, { hubTags: ["Birmingham"] })).toHaveLength(0);
  });

  it("DJ Johnson 2026-08-21 Dallas: one morning block at the yard including the lunch break", () => {
    const V = "281474996579824";
    const segs = build("53243889", "DJ Johnson", [
      { status: "offDuty", startMs: at(CT, 21, 0, 0), endMs: at(CT, 21, 9, 52, 59), latitude: 32.811392, longitude: -96.878043, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 9, 52, 59), endMs: at(CT, 21, 10, 5, 33), latitude: 32.811604, longitude: -96.877881, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 10, 5, 33), endMs: at(CT, 21, 11, 22, 47), latitude: 32.810792, longitude: -96.877975, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 21, 11, 22, 47), endMs: at(CT, 21, 13, 32, 20), latitude: 32.810792, longitude: -96.877975, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 13, 32, 20), endMs: at(CT, 21, 13, 48, 23), latitude: 32.81147, longitude: -96.877954, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 13, 48, 23), endMs: at(CT, 21, 14, 49, 16), latitude: 32.809267, longitude: -96.892608, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 16, 11, 1), endMs: at(CT, 21, 20, 39, 40), latitude: 32.808819, longitude: -96.892867, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 20, 47, 26), endMs: at(CT, 21, 21, 0), latitude: 32.809898, longitude: -96.892407, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 21, 21, 0), endMs: at(CT, 22, 0, 0), latitude: 32.809898, longitude: -96.892407, vehicleId: V },
    ]);
    const events = run({ id: "53243889", name: "DJ Johnson" }, segs, { hubTags: ["Dallas"] });
    expect(events).toHaveLength(1);
    expect(events[0].hub).toBe("Dallas");
    expect(events[0].locationSource).toBe("log");
    // The work package expected 236 min (09:52–13:48). The rule as specified
    // ends the block at 13:32:20: the 13:32–13:48 driving segment starts in the
    // fence but the next located segment is 1,276 m away, so it is a drive-away.
    // 09:52:59 -> 13:32:20 = 220 min.
    expect(events[0].durationMin).toBeGreaterThanOrEqual(219);
    expect(events[0].durationMin).toBeLessThanOrEqual(221);
  });
});

describe("presence basis — rules", () => {
  const V = "v1";
  const IN = { latitude: 32.8110, longitude: -96.87795 };
  const OUT = { latitude: 32.7000, longitude: -96.7000 };
  const d = { id: "d1", name: "Ray Driver" };

  it("overnight off-duty inside the fence before the first working segment does not count", () => {
    const segs = build("d1", "Ray Driver", [
      { status: "offDuty", startMs: at(CT, 5, 0), endMs: at(CT, 5, 8), ...IN, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 9), ...IN, vehicleId: V },
    ]);
    const events = run(d, segs);
    expect(events).toHaveLength(0); // 60 min of on-duty only, the 8 overnight hours are dropped
  });

  it("an off-duty lunch inside the fence between two in-fence segments counts", () => {
    const segs = build("d1", "Ray Driver", [
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 11), ...IN, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 5, 11), endMs: at(CT, 5, 12), ...IN, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 5, 12), endMs: at(CT, 5, 15), ...IN, vehicleId: V },
    ]);
    const events = run(d, segs);
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(420);
    expect(events[0].statuses).toEqual(["onDuty", "offDuty"]);
  });

  it("a driving segment starting in the fence and ending outside does not count", () => {
    const segs = build("d1", "Ray Driver", [
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 10), ...IN, vehicleId: V },
      { status: "driving", startMs: at(CT, 5, 10), endMs: at(CT, 5, 12), ...IN, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 5, 12), endMs: at(CT, 5, 14), ...OUT, vehicleId: V },
    ]);
    const events = run(d, segs);
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(120); // 08:00–10:00 only
  });

  it("a driving segment starting and ending in the fence counts", () => {
    const segs = build("d1", "Ray Driver", [
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 10), ...IN, vehicleId: V },
      { status: "driving", startMs: at(CT, 5, 10), endMs: at(CT, 5, 12), ...IN, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 5, 12), endMs: at(CT, 5, 14), ...IN, vehicleId: V },
    ]);
    const events = run(d, segs);
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(360);
  });

  it("ambiguous hub tags do not attribute vehicle-less on-duty time", () => {
    const segs = build("d1", "Ray Driver", [
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 16) },
    ]);
    expect(run(d, segs, { hubTags: ["Dallas", "Ocala"] })).toHaveLength(0);
  });
});
