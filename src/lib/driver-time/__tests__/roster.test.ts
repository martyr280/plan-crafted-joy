import { describe, expect, it } from "vitest";
import {
  buildDriverRoster,
  hiddenDriversInEvents,
  hiddenRosterNotice,
  nextDriverTimeValue,
  rosterTokenMatches,
  MAX_EXCLUDED_DRIVER_IDS,
} from "../roster";

// Synthetic people and ids only.
const settings = {
  excludedDriverIds: ["900"],
  excludedDriverNamePatterns: ["Test Hub Warehouse"],
};

describe("buildDriverRoster", () => {
  it("keeps a hidden driver with a rate row off the active list, rate history still reachable", () => {
    const { active, excluded } = buildDriverRoster({
      rosterActive: [{ id: "100", name: "Avery Active" }],
      rosterAll: [
        { id: "100", name: "Avery Active" },
        { id: "900", name: "Harper Hidden" },
      ],
      events: [{ driver_id: "900", driver_name: "Harper Hidden" }],
      rates: [{ driver_id: "900", driver_name: "Harper Hidden" }],
      settings,
    });
    expect(active.map((d) => d.id)).toEqual(["100"]);
    expect(excluded).toEqual([
      { id: "900", name: "Harper Hidden", reason: "id", alsoMatchesPattern: false, hasRates: true },
    ]);
  });

  it("adds event-only and rate-only drivers that are not excluded", () => {
    const { active } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [],
      events: [{ driver_id: "200", driver_name: "Evan Events" }],
      rates: [
        { driver_id: "300", driver_name: "Riley Rates" },
        { driver_id: 200, driver_name: "Evan Events" },
      ],
      settings,
    });
    expect(active).toEqual([
      { id: "200", name: "Evan Events", source: "events" },
      { id: "300", name: "Riley Rates", source: "rates" },
    ]);
  });

  it("lists every hidden id, naming from Samsara, then events, then rates, then the id", () => {
    const { excluded } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [{ id: "1", name: "Samsara Name" }],
      events: [
        { driver_id: "1", driver_name: "Event Name" },
        { driver_id: "2", driver_name: "Only Events" },
      ],
      rates: [{ driver_id: "3", driver_name: "Only Rates" }],
      settings: { excludedDriverIds: ["1", "2", "3", "4", "4"], excludedDriverNamePatterns: [] },
    });
    expect(excluded.map((d) => [d.id, d.name])).toEqual([
      ["4", "4"],
      ["2", "Only Events"],
      ["3", "Only Rates"],
      ["1", "Samsara Name"],
    ]);
  });

  it("flags an id-hidden driver that also matches a name pattern", () => {
    const { excluded } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [{ id: "900", name: "Test Hub Warehouse 2" }],
      events: [],
      rates: [],
      settings,
    });
    expect(excluded[0]).toMatchObject({ id: "900", reason: "id", alsoMatchesPattern: true });
  });

  it("pattern-only exclusions surface only when they carry rate history", () => {
    const { active, excluded } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [],
      events: [{ driver_id: "500", driver_name: "Test Hub Warehouse" }],
      rates: [{ driver_id: "600", driver_name: "Test Hub Warehouse B" }],
      settings: { excludedDriverIds: [], excludedDriverNamePatterns: ["Test Hub Warehouse"] },
    });
    expect(active).toEqual([]);
    expect(excluded).toEqual([
      {
        id: "600",
        name: "Test Hub Warehouse B",
        reason: "pattern",
        alsoMatchesPattern: true,
        hasRates: true,
      },
    ]);
  });
});

describe("nextDriverTimeValue", () => {
  const saved = {
    excludedDriverIds: ["900"],
    excludedDriverNamePatterns: ["Test Hub LTL"],
    warehouseRemarkDriverIds: ["700"],
    thresholdMinutes: 75,
    hubTzByAddress: { a1: "America/Chicago" },
    someFutureKey: { nested: true },
  };

  it("hide appends the id and preserves every other key exactly as saved", () => {
    const next = nextDriverTimeValue(saved, "123", true);
    expect(next.changed).toBe(true);
    expect(next.value).toEqual({ ...saved, excludedDriverIds: ["900", "123"] });
    // Defaults are never written into the row.
    expect(next.value.excludedDriverNamePatterns).toEqual(["Test Hub LTL"]);
    expect(saved.excludedDriverIds).toEqual(["900"]);
  });

  it("hide is idempotent", () => {
    const once = nextDriverTimeValue(saved, "123", true);
    const twice = nextDriverTimeValue(once.value, "123", true);
    expect(twice.changed).toBe(false);
    expect(twice.value).toEqual(once.value);
    expect(nextDriverTimeValue(saved, "900", true).changed).toBe(false);
  });

  it("restore removes the id, is idempotent, and preserves every other key", () => {
    const restored = nextDriverTimeValue(saved, "900", false);
    expect(restored.changed).toBe(true);
    expect(restored.value).toEqual({ ...saved, excludedDriverIds: [] });
    expect(nextDriverTimeValue(restored.value, "900", false).changed).toBe(false);
  });

  it("numeric ids in the saved row match their string form", () => {
    expect(nextDriverTimeValue({ excludedDriverIds: [900] }, "900", true).changed).toBe(false);
    expect(nextDriverTimeValue({ excludedDriverIds: [900] }, "900", false).value).toEqual({
      excludedDriverIds: [],
    });
  });

  it("a missing row or missing key starts an empty list", () => {
    expect(nextDriverTimeValue(null, "1", true).value).toEqual({ excludedDriverIds: ["1"] });
    expect(nextDriverTimeValue({ basis: "presence" }, "1", true).value).toEqual({
      basis: "presence",
      excludedDriverIds: ["1"],
    });
  });

  it("refuses a malformed row instead of overwriting it", () => {
    expect(() => nextDriverTimeValue([], "1", true)).toThrow(/expected shape/);
    expect(() => nextDriverTimeValue("x", "1", true)).toThrow(/expected shape/);
    expect(() => nextDriverTimeValue({ excludedDriverIds: "900" }, "1", true)).toThrow(
      /not a list/,
    );
  });

  it("caps the hidden list", () => {
    const full = {
      excludedDriverIds: Array.from({ length: MAX_EXCLUDED_DRIVER_IDS }, (_, i) => `${i}`),
    };
    expect(() => nextDriverTimeValue(full, "new", true)).toThrow(/At most/);
  });
});

describe("rosterTokenMatches", () => {
  it("matches exact tokens and null-for-null only", () => {
    expect(rosterTokenMatches("t1", "t1")).toBe(true);
    expect(rosterTokenMatches(null, null)).toBe(true);
    expect(rosterTokenMatches("t1", "t2")).toBe(false);
    expect(rosterTokenMatches(null, "t1")).toBe(false);
    expect(rosterTokenMatches("t1", null)).toBe(false);
  });
});

describe("hidden drivers in the weekly report", () => {
  it("counts only id-hidden drivers and their events", () => {
    const events = [
      { driver_id: "900" },
      { driver_id: "900" },
      { driver_id: 901 },
      { driver_id: "1" },
    ];
    expect(hiddenDriversInEvents(events, ["900", "901"])).toEqual({ drivers: 2, events: 3 });
    expect(hiddenDriversInEvents(events, [])).toEqual({ drivers: 0, events: 0 });
  });

  it("says so in plain words, and nothing when no one is hidden", () => {
    expect(hiddenRosterNotice({ drivers: 0, events: 0 })).toBeNull();
    expect(hiddenRosterNotice(undefined)).toBeNull();
    expect(hiddenRosterNotice({ drivers: 1, events: 1 })).toMatch(
      /^1 driver hidden from the roster has 1 warehouse event in this window\. They are not in this report or the estimated cost\./,
    );
    expect(hiddenRosterNotice({ drivers: 2, events: 5 })).toMatch(
      /^2 drivers .* have 5 warehouse events/,
    );
  });
});
