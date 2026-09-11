import { describe, expect, it } from "vitest";
import {
  backfillSegmentVehicles,
  centralDaysCovering,
  centralMidnight,
  coversEntities,
  isCacheDayFresh,
} from "@/lib/samsara/cache-window";

const HOUR = 3_600_000;

describe("centralDaysCovering", () => {
  it("splits a window into whole Central days", () => {
    const start = centralMidnight("2026-08-17");
    const end = centralMidnight("2026-08-20");
    expect(centralDaysCovering(start, end).map((d) => d.date)).toEqual(["2026-08-17", "2026-08-18", "2026-08-19"]);
  });

  it("returns the single day a partial window falls inside", () => {
    const start = centralMidnight("2026-08-17") + 6 * HOUR;
    const days = centralDaysCovering(start, start + 2 * HOUR);
    expect(days.map((d) => d.date)).toEqual(["2026-08-17"]);
    expect(days[0].startMs).toBe(centralMidnight("2026-08-17"));
    expect(days[0].endMs).toBe(centralMidnight("2026-08-18"));
  });

  it("is empty for an inverted window", () => {
    expect(centralDaysCovering(2000, 1000)).toEqual([]);
  });

  it("crosses the DST boundary without losing or duplicating a day", () => {
    const start = centralMidnight("2026-11-01");
    const end = centralMidnight("2026-11-03");
    expect(centralDaysCovering(start, end).map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02"]);
  });
});

describe("isCacheDayFresh", () => {
  const dayAfter = centralMidnight("2026-08-19");

  it("keeps a closed day fetched after it closed", () => {
    const row = { day_date: "2026-08-18", fetched_at: new Date(dayAfter + HOUR).toISOString(), complete: true };
    expect(isCacheDayFresh(row, dayAfter + 40 * 86_400_000)).toBe(true);
  });

  it("expires a day that was still in progress when fetched", () => {
    const midDay = centralMidnight("2026-08-18") + 10 * HOUR;
    const row = { day_date: "2026-08-18", fetched_at: new Date(midDay).toISOString(), complete: false };
    expect(isCacheDayFresh(row, midDay + 10 * 60_000)).toBe(true);
    expect(isCacheDayFresh(row, midDay + 31 * 60_000)).toBe(false);
  });

  it("rejects an unparseable fetch time", () => {
    expect(isCacheDayFresh({ day_date: "2026-08-18", fetched_at: "not a date", complete: true }, Date.now())).toBe(false);
  });
});

describe("coversEntities", () => {
  it("requires every requested id", () => {
    expect(coversEntities(["a", "b"], ["a"])).toBe(true);
    expect(coversEntities(["a"], ["a", "b"])).toBe(false);
  });

  it("treats a wildcard as full coverage and a bad value as none", () => {
    expect(coversEntities(["*"], ["a", "b"])).toBe(true);
    expect(coversEntities(null, ["a"])).toBe(false);
    expect(coversEntities(null, [])).toBe(true);
  });
});

describe("backfillSegmentVehicles", () => {
  const seg = (over: Partial<{ driverId: string; startMs: number; endMs: number; vehicleId: string | null }> = {}) => ({
    driverId: "d1",
    startMs: 1_000,
    endMs: 5_000,
    vehicleId: null as string | null,
    ...over,
  });

  it("fills the most overlapping assignment", () => {
    const { segments, filled } = backfillSegmentVehicles(
      [seg()],
      [
        { driverId: "d1", vehicleId: "v-short", startMs: 0, endMs: 2_000 },
        { driverId: "d1", vehicleId: "v-long", startMs: 2_000, endMs: 9_000 },
      ],
    );
    expect(filled).toBe(1);
    expect(segments[0].vehicleId).toBe("v-long");
  });

  it("never overwrites a vehicle Samsara already reported", () => {
    const { segments, filled } = backfillSegmentVehicles(
      [seg({ vehicleId: "v-real" })],
      [{ driverId: "d1", vehicleId: "v-other", startMs: 0, endMs: 9_000 }],
    );
    expect(filled).toBe(0);
    expect(segments[0].vehicleId).toBe("v-real");
  });

  it('treats "0" and blank as missing', () => {
    const { filled } = backfillSegmentVehicles(
      [seg({ vehicleId: "0" }), seg({ vehicleId: "  " })],
      [{ driverId: "d1", vehicleId: "v1", startMs: 0, endMs: 9_000 }],
    );
    expect(filled).toBe(2);
  });

  it("ignores another driver's assignment and non-overlapping windows", () => {
    const { segments, filled } = backfillSegmentVehicles(
      [seg()],
      [
        { driverId: "d2", vehicleId: "v-other-driver", startMs: 0, endMs: 9_000 },
        { driverId: "d1", vehicleId: "v-later", startMs: 6_000, endMs: 8_000 },
      ],
    );
    expect(filled).toBe(0);
    expect(segments[0].vehicleId).toBeNull();
  });

  it("uses an open-ended assignment", () => {
    const { segments } = backfillSegmentVehicles([seg()], [
      { driverId: "d1", vehicleId: "v-open", startMs: 0, endMs: null },
    ]);
    expect(segments[0].vehicleId).toBe("v-open");
  });
});
