import { describe, expect, it } from "vitest";
import { normalizeCity, normalizeState } from "../address-match";
import { parseSequencePaste } from "../paste";
import { buildLoadSheet } from "../loadsheet";
import { occurrencesBetween, cutoffsFiredSince, dueCutoffs, nextWatermark } from "../watermark";
import type { RouteCutoff } from "@/lib/truck-capacity/cutoffs";

describe("city normalizer", () => {
  it("does NOT expand street words in city names", () => {
    expect(normalizeCity("St Louis")).toBe("SAINT LOUIS");
    expect(normalizeCity("St. Louis")).toBe("SAINT LOUIS");
    expect(normalizeCity("Saint Louis")).toBe("SAINT LOUIS");
  });
  it("leaves directional and street-suffix-looking city tokens alone", () => {
    expect(normalizeCity("North Little Rock")).toBe("NORTH LITTLE ROCK");
    expect(normalizeCity("St Charles")).toBe("SAINT CHARLES");
    // A bare "St" city (unlikely) must not become SAINT with nothing after it.
    expect(normalizeCity("St")).toBe("ST");
  });
  it("uppercases and collapses punctuation", () => {
    expect(normalizeCity("  d'iberville ")).toBe("D IBERVILLE");
    expect(normalizeState(" al ")).toBe("AL");
  });
});

describe("paste importer", () => {
  it("parses city/state/day and flags pickups", () => {
    const p = parseSequencePaste("Birmingham, AL, MON\nBourg, LA, WED (Thur)\nVendor Yard, MS, TUE, PICKUP");
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => [r.position, r.cityNorm, r.state, r.deliveryDowLabel, r.isPickup])).toEqual([
      [1, "BIRMINGHAM", "AL", "MON", false],
      [2, "BOURG", "LA", "WED (Thur)", false],
      [3, "VENDOR YARD", "MS", "TUE", true],
    ]);
  });
  it("keeps day labels verbatim", () => {
    const p = parseSequencePaste("Bourg, LA, Thur/FRI");
    expect(p.rows[0]!.deliveryDowLabel).toBe("Thur/FRI");
  });
  it("reports bad lines without aborting and numbers positions over valid rows only", () => {
    const p = parseSequencePaste("Birmingham, AL, MON\nnope\n# comment\n\nMobile, AL, TUE");
    expect(p.errors.map((e) => e.lineNo)).toEqual([2]);
    expect(p.rows.map((r) => r.position)).toEqual([1, 2]);
  });
});

describe("load sheet", () => {
  it("reverses delivery order and drops held stops", () => {
    const sheet = buildLoadSheet([
      { position: 1, hold: false, estPallets: 2 },
      { position: 2, hold: true, estPallets: 5 },
      { position: 3, hold: false, estPallets: 3 },
    ]);
    expect(sheet.stops.map((s) => [s.loadOrder, s.deliveryPosition])).toEqual([[1, 3], [2, 1]]);
    expect(sheet.totals.pallets).toBe(5);
    expect(sheet.totals.stops).toBe(2);
  });
});

describe("builder watermark", () => {
  const cutoff: RouteCutoff = {
    id: "c1",
    route_id: "r1",
    label: "Mon 14:00",
    cutoff_dow: 1,
    cutoff_time: "14:00",
    tz: "America/Chicago",
    run_dows: [2],
    active: true,
  } as unknown as RouteCutoff;

  const monday14 = Date.parse("2026-08-24T19:00:00Z"); // 14:00 CDT

  it("finds an occurrence exactly once in a straddling window", () => {
    const occ = occurrencesBetween(cutoff, monday14 - 60_000, monday14 + 60_000);
    expect(occ).toHaveLength(1);
    // Exclusive lower bound: re-running the same window from the fire instant yields nothing.
    expect(occurrencesBetween(cutoff, monday14, monday14 + 60_000)).toHaveLength(0);
  });

  it("holds a fired cutoff until the build delay has elapsed, then releases it", () => {
    const fired = cutoffsFiredSince([cutoff], monday14 - 60_000, monday14 + 60_000, 10);
    expect(fired).toHaveLength(1);
    expect(dueCutoffs(fired, monday14 + 60_000)).toHaveLength(0);
    expect(dueCutoffs(fired, monday14 + 11 * 60_000)).toHaveLength(1);
  });

  it("does not advance the watermark past a cutoff that is not yet due", () => {
    const nowMs = monday14 + 60_000;
    const fired = cutoffsFiredSince([cutoff], monday14 - 60_000, nowMs, 10);
    expect(nextWatermark(fired, nowMs)).toBeLessThan(monday14);
    const later = monday14 + 11 * 60_000;
    expect(nextWatermark(cutoffsFiredSince([cutoff], monday14 - 60_000, later, 10), later)).toBe(later);
  });
});
