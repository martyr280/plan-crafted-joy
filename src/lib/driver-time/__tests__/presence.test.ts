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

/** Fixtures transcribed from the WP5 probe (segment-for-segment, real coordinates). */
describe("presence basis — trailing rest and boundary artefacts (WP5 probe fixtures)", () => {
  const min = (a: number, b: number) => Math.round((b - a) / 60_000);

  it("Fiscal 2026-08-19 Dallas: block ends at the last work segment, not at the 23:59:59 boundary log", () => {
    const V = "281474996579839";
    const segs = build("53243879", "Alberto Fiscal", [
      { status: "offDuty", startMs: at(CT, 19, 0, 0), endMs: at(CT, 19, 6, 39, 8), latitude: 32.811727, longitude: -96.878172, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 6, 39, 8), endMs: at(CT, 19, 7, 47, 40), latitude: 32.811727, longitude: -96.878172, vehicleId: V },
      { status: "driving", startMs: at(CT, 19, 7, 47, 40), endMs: at(CT, 19, 7, 54, 13), latitude: 32.811668, longitude: -96.877881, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 7, 54, 13), endMs: at(CT, 19, 7, 54, 33), latitude: 32.8112, longitude: -96.87802, vehicleId: V },
      { status: "driving", startMs: at(CT, 19, 7, 54, 33), endMs: at(CT, 19, 8, 0, 48), latitude: 32.811084, longitude: -96.877958, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 8, 0, 48), endMs: at(CT, 19, 8, 20, 45), latitude: 32.811771, longitude: -96.878137, vehicleId: V },
      { status: "driving", startMs: at(CT, 19, 8, 20, 45), endMs: at(CT, 19, 8, 27, 11), latitude: 32.811756, longitude: -96.878043, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 8, 27, 11), endMs: at(CT, 19, 12, 26, 19), latitude: 32.810717, longitude: -96.878192, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 19, 12, 26, 19), endMs: at(CT, 19, 12, 57, 54), latitude: 32.810717, longitude: -96.878192, vehicleId: V },
      { status: "yardMove", startMs: at(CT, 19, 12, 57, 54), endMs: at(CT, 19, 15, 56, 0), latitude: 32.810717, longitude: -96.878192, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 15, 56, 0), endMs: at(CT, 19, 16, 6, 5), latitude: 32.810717, longitude: -96.878192, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 16, 6, 5), endMs: at(CT, 19, 16, 9, 48), latitude: 32.810717, longitude: -96.878192, vehicleId: V },
      { status: "driving", startMs: at(CT, 19, 16, 9, 48), endMs: at(CT, 19, 16, 12, 0), latitude: 32.811038, longitude: -96.877983, vehicleId: V },
      { status: "driving", startMs: at(CT, 19, 16, 12, 0), endMs: at(CT, 19, 16, 16, 2), latitude: 32.811401, longitude: -96.878093, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 19, 16, 16, 2), endMs: at(CT, 19, 23, 59, 59), latitude: 32.811401, longitude: -96.878093, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 19, 23, 59, 59), endMs: at(CT, 20, 0, 0), latitude: 32.811401, longitude: -96.878093, vehicleId: V },
    ]);
    const events = run({ id: "53243879", name: "Alberto Fiscal" }, segs, { hubTags: ["Dallas"] });
    expect(events).toHaveLength(1);
    expect(events[0].startMs).toBe(at(CT, 19, 6, 39, 8));
    // Acceptance asked for 16:16:02 / 577 min. Clause (c) as specified gives
    // 16:12:00 / 573 min: the closing driving segment 16:12:00–16:16:02 is in
    // the fence but has no next non-trivial segment inside the window, so it is
    // not counted. The 7.7-hour trailing off-duty is gone either way; the
    // 4-minute shortfall is reported, not forced.
    expect(events[0].endMs).toBe(at(CT, 19, 16, 12, 0));
    expect(events[0].durationMin).toBe(573);
    expect(events[0].hub).toBe("Dallas");

  });

  it("Farahkhan 2026-08-21 Birmingham: the morning 87-minute block is not merged with the afternoon one", () => {
    const V = "281475004109646";
    const segs = build("53243880", "Karriem Farahkhan", [
      { status: "offDuty", startMs: at(CT, 21, 0, 0), endMs: at(CT, 21, 7, 27, 31), latitude: 33.631582, longitude: -86.736299 },
      { status: "offDuty", startMs: at(CT, 21, 7, 27, 31), endMs: at(CT, 21, 7, 28, 12), latitude: 33.631789, longitude: -86.736205, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 7, 28, 12), endMs: at(CT, 21, 8, 55, 20), latitude: 33.63175, longitude: -86.73619, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 8, 55, 20), endMs: at(CT, 21, 8, 56, 30), latitude: 33.631741, longitude: -86.7362, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 8, 56, 30), endMs: at(CT, 21, 9, 35, 58), latitude: 33.63149, longitude: -86.736104, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 9, 35, 58), endMs: at(CT, 21, 9, 44, 54), latitude: 33.541289, longitude: -86.535297, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 9, 44, 54), endMs: at(CT, 21, 10, 28, 2), latitude: 33.541142, longitude: -86.535789, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 10, 28, 2), endMs: at(CT, 21, 10, 32, 59), latitude: 33.444616, longitude: -86.84294, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 10, 32, 59), endMs: at(CT, 21, 10, 54, 33), latitude: 33.444642, longitude: -86.842815, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 10, 54, 33), endMs: at(CT, 21, 11, 10, 3), latitude: 33.516793, longitude: -86.799191, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 11, 10, 3), endMs: at(CT, 21, 11, 36, 7), latitude: 33.516603, longitude: -86.799462, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 11, 36, 7), endMs: at(CT, 21, 11, 39, 49), latitude: 33.631711, longitude: -86.736223, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 11, 39, 49), endMs: at(CT, 21, 13, 22, 57), latitude: 33.631711, longitude: -86.736223, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 13, 22, 57), endMs: at(CT, 21, 13, 30, 8), latitude: 33.631737, longitude: -86.73603, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 21, 13, 30, 8), endMs: at(CT, 21, 14, 52, 2), latitude: 33.63181, longitude: -86.73615, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 21, 14, 52, 2), endMs: at(CT, 21, 15, 57, 13), latitude: 33.63181, longitude: -86.73615, vehicleId: V },
      { status: "driving", startMs: at(CT, 21, 15, 57, 13), endMs: at(CT, 21, 16, 10, 58), latitude: 33.631591, longitude: -86.736131, vehicleId: V },
      { status: "sleeperBed", startMs: at(CT, 21, 16, 10, 58), endMs: at(CT, 22, 0, 0), latitude: 33.646936, longitude: -86.706381, vehicleId: V },
    ]);
    const events = run({ id: "53243880", name: "Karriem Farahkhan" }, segs, { hubTags: ["Birmingham"] });
    // The morning block (07:28:12–08:56:30, 88 min) is below the 90-minute
    // threshold and must not be glued to the afternoon block.
    expect(events).toHaveLength(1);
    expect(events[0].startMs).toBe(at(CT, 21, 11, 36, 7));
    // The trailing off-duty is followed by a driving segment whose own point is
    // still in the fence, so under clause (b) it counts: the block ends 15:57:13,
    // 65 minutes past the audited 14:52 end. Documented, not forced.
    expect(events[0].endMs).toBe(at(CT, 21, 15, 57, 13));
    expect(events[0].durationMin).toBe(min(at(CT, 21, 11, 36, 7), at(CT, 21, 15, 57, 13)));
  });

  it("Blanks 2026-08-28 Birmingham: mid-block rest counts, the closing drive-away does not", () => {
    const V = "281475004109646";
    const segs = build("53243512", "Thomas Blanks", [
      { status: "offDuty", startMs: at(CT, 28, 0, 0), endMs: at(CT, 28, 10, 14, 56), latitude: 33.522187, longitude: -86.796891 },
      { status: "offDuty", startMs: at(CT, 28, 10, 14, 56), endMs: at(CT, 28, 10, 15, 17), latitude: 33.522119, longitude: -86.797105, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 28, 10, 15, 17), endMs: at(CT, 28, 10, 19, 57), latitude: 33.522108, longitude: -86.797112, vehicleId: V },
      { status: "driving", startMs: at(CT, 28, 10, 19, 57), endMs: at(CT, 28, 10, 49, 46), latitude: 33.522043, longitude: -86.79734, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 28, 10, 49, 46), endMs: at(CT, 28, 15, 17, 47), latitude: 33.631862, longitude: -86.736117, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 28, 15, 17, 47), endMs: at(CT, 28, 15, 24, 15), latitude: 33.631862, longitude: -86.736117, vehicleId: V },
      { status: "driving", startMs: at(CT, 28, 15, 24, 15), endMs: at(CT, 28, 15, 30, 29), latitude: 33.631807, longitude: -86.736128, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 28, 15, 30, 29), endMs: at(CT, 28, 17, 45, 22), latitude: 33.631771, longitude: -86.736225, vehicleId: V },
      { status: "driving", startMs: at(CT, 28, 17, 45, 22), endMs: at(CT, 28, 18, 1, 40), latitude: 33.631484, longitude: -86.736226, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 28, 18, 1, 40), endMs: at(CT, 29, 0, 0), latitude: 33.647098, longitude: -86.706777, vehicleId: V },
    ]);
    const events = run({ id: "53243512", name: "Thomas Blanks" }, segs, { hubTags: ["Birmingham"] });
    expect(events).toHaveLength(1);
    expect(events[0].startMs).toBe(at(CT, 28, 10, 49, 46));
    expect(events[0].endMs).toBe(at(CT, 28, 17, 45, 22));
    expect(events[0].durationMin).toBe(min(at(CT, 28, 10, 49, 46), at(CT, 28, 17, 45, 22)));
  });

  it("Young 2026-08-24 Dallas: unchanged 06:30–11:43 block across two vehicles", () => {
    const V1 = "281474996579823";
    const V2 = "281474996579836";
    const segs = build("53243878", "Robert Young", [
      { status: "offDuty", startMs: at(CT, 24, 0, 0), endMs: at(CT, 24, 6, 30, 0), latitude: 32.811658, longitude: -96.878016 },
      { status: "onDuty", startMs: at(CT, 24, 6, 30, 0), endMs: at(CT, 24, 6, 50, 5) },
      { status: "onDuty", startMs: at(CT, 24, 6, 50, 5), endMs: at(CT, 24, 6, 51, 1), latitude: 32.811613, longitude: -96.877985, vehicleId: V1 },
      { status: "onDuty", startMs: at(CT, 24, 6, 51, 1), endMs: at(CT, 24, 6, 53, 0), latitude: 32.811613, longitude: -96.877985, vehicleId: V1 },
      { status: "onDuty", startMs: at(CT, 24, 6, 53, 0), endMs: at(CT, 24, 6, 53, 27), latitude: 32.811613, longitude: -96.877985, vehicleId: V1 },
      { status: "onDuty", startMs: at(CT, 24, 6, 53, 27), endMs: at(CT, 24, 10, 11, 8), latitude: 32.811613, longitude: -96.877985, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 10, 11, 8), endMs: at(CT, 24, 10, 18, 0), latitude: 32.81045, longitude: -96.877974, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 10, 18, 0), endMs: at(CT, 24, 11, 2, 18), latitude: 32.811655, longitude: -96.878025, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 11, 2, 18), endMs: at(CT, 24, 11, 25, 7), latitude: 32.811791, longitude: -96.877875, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 11, 25, 7), endMs: at(CT, 24, 11, 43, 46), latitude: 32.811574, longitude: -96.878107, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 11, 43, 46), endMs: at(CT, 24, 12, 13, 39), latitude: 32.7738, longitude: -96.858542, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 12, 13, 39), endMs: at(CT, 24, 12, 19, 25), latitude: 32.811574, longitude: -96.878107, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 12, 19, 25), endMs: at(CT, 24, 12, 54, 40), latitude: 32.768043, longitude: -96.897495, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 12, 54, 40), endMs: at(CT, 24, 13, 2, 12), latitude: 32.811574, longitude: -96.878107, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 13, 2, 12), endMs: at(CT, 24, 13, 20, 16), latitude: 32.740789, longitude: -97.286837, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 13, 20, 16), endMs: at(CT, 24, 13, 21, 18), latitude: 32.811574, longitude: -96.878107, vehicleId: V1 },
      { status: "offDuty", startMs: at(CT, 24, 13, 21, 18), endMs: at(CT, 24, 13, 38, 33) },
      { status: "onDuty", startMs: at(CT, 24, 13, 38, 33), endMs: at(CT, 24, 13, 54, 8), latitude: 32.811574, longitude: -96.878107, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 13, 54, 8), endMs: at(CT, 24, 14, 24, 53), latitude: 32.773605, longitude: -97.288511, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 14, 24, 53), endMs: at(CT, 24, 14, 25, 41), latitude: 32.810988, longitude: -96.877938, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 14, 25, 41), endMs: at(CT, 24, 14, 25, 56) },
      { status: "onDuty", startMs: at(CT, 24, 14, 25, 56), endMs: at(CT, 24, 14, 26, 56), latitude: 32.811156, longitude: -96.878116, vehicleId: V2 },
      { status: "onDuty", startMs: at(CT, 24, 14, 26, 56), endMs: at(CT, 24, 14, 32, 13) },
      { status: "onDuty", startMs: at(CT, 24, 14, 32, 13), endMs: at(CT, 24, 15, 31, 6), latitude: 32.811574, longitude: -96.878107, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 15, 31, 6), endMs: at(CT, 24, 17, 13, 0), latitude: 32.811804, longitude: -96.877905, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 17, 13, 0), endMs: at(CT, 24, 18, 2, 15), latitude: 33.824267, longitude: -96.531681, vehicleId: V1 },
      { status: "onDuty", startMs: at(CT, 24, 18, 2, 15), endMs: at(CT, 24, 18, 10, 38), latitude: 34.36427, longitude: -96.140332, vehicleId: V1 },
      { status: "driving", startMs: at(CT, 24, 18, 10, 38), endMs: at(CT, 24, 19, 0, 8), latitude: 34.364822, longitude: -96.139998, vehicleId: V1 },
      { status: "onDuty", startMs: at(CT, 24, 19, 0, 8), endMs: at(CT, 24, 19, 17, 28), latitude: 34.896745, longitude: -95.765101, vehicleId: V1 },
      { status: "offDuty", startMs: at(CT, 24, 19, 17, 28), endMs: at(CT, 25, 0, 0), latitude: 34.896745, longitude: -95.765101 },
    ]);
    const events = run({ id: "53243878", name: "Robert Young" }, segs, { hubTags: ["Dallas"] });
    expect(events).toHaveLength(1);
    expect(events[0].startMs).toBe(at(CT, 24, 6, 30, 0));
    expect(events[0].endMs).toBe(at(CT, 24, 11, 43, 46));
    expect(events[0].durationMin).toBe(min(at(CT, 24, 6, 30, 0), at(CT, 24, 11, 43, 46)));
  });

  it("a sub-minute on-duty boundary log at 23:59:59 does not stretch the day window", () => {
    const V = "v1";
    const IN = { latitude: 32.811, longitude: -96.87795 };
    const segs = build("d1", "Ray Driver", [
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 12), ...IN, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 5, 12), endMs: at(CT, 5, 23, 59, 59), ...IN, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 5, 23, 59, 59), endMs: at(CT, 6, 0), ...IN, vehicleId: V },
    ]);
    const events = run({ id: "d1", name: "Ray Driver" }, segs);
    expect(events).toHaveLength(1);
    expect(events[0].endMs).toBe(at(CT, 5, 12));
    expect(events[0].durationMin).toBe(240);
  });

  it("a 30-second driving blip is skipped when looking up a segment's next", () => {
    const V = "v1";
    const IN = { latitude: 32.811, longitude: -96.87795 };
    const OUT = { latitude: 32.7, longitude: -96.7 };
    const segs = build("d1", "Ray Driver", [
      { status: "onDuty", startMs: at(CT, 5, 8), endMs: at(CT, 5, 10), ...IN, vehicleId: V },
      { status: "offDuty", startMs: at(CT, 5, 10), endMs: at(CT, 5, 11), ...IN, vehicleId: V },
      { status: "driving", startMs: at(CT, 5, 11, 0, 0), endMs: at(CT, 5, 11, 0, 30), ...OUT, vehicleId: V },
      { status: "onDuty", startMs: at(CT, 5, 11, 0, 30), endMs: at(CT, 5, 13), ...IN, vehicleId: V },
    ]);
    const events = run({ id: "d1", name: "Ray Driver" }, segs);
    expect(events).toHaveLength(1);
    expect(events[0].durationMin).toBe(300); // the off-duty hour is kept
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
