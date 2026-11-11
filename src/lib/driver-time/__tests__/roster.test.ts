import { describe, expect, it } from "vitest";
import {
  buildDriverRoster,
  hiddenRosterNotice,
  nextDriverTimeValue,
  rosterTokenMatches,
  scopeWeekInputs,
  MAX_EXCLUDED_DRIVER_IDS,
} from "../roster";

// Synthetic people and ids only.
const settings = {
  excludedDriverIds: ["900"],
  excludedDriverNamePatterns: ["Test Hub Warehouse"],
  excludedDrivers: [],
};
const TODAY = "2026-11-11";
const entry = {
  hiddenFrom: "2026-11-09",
  hiddenBy: "user-1",
  hiddenAt: "2026-11-11T17:00:00.000Z",
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
      asOf: TODAY,
    });
    expect(active.map((d) => d.id)).toEqual(["100"]);
    expect(excluded).toEqual([
      {
        id: "900",
        name: "Harper Hidden",
        reason: "id",
        hiddenFrom: null,
        alsoMatchesPattern: false,
        hasRates: true,
      },
    ]);
  });

  it("a dated hide in effect today removes the driver from the active list", () => {
    const dated = {
      ...settings,
      excludedDriverIds: [],
      excludedDrivers: [{ id: "800", hiddenFrom: "2026-11-09" }],
    };
    const input = {
      rosterActive: [{ id: "800", name: "Dana Dated" }],
      rosterAll: [{ id: "800", name: "Dana Dated" }],
      events: [{ driver_id: "800", driver_name: "Dana Dated" }],
      rates: [{ driver_id: "800", driver_name: "Dana Dated" }],
      settings: dated,
    };
    const now = buildDriverRoster({ ...input, asOf: TODAY });
    expect(now.active).toEqual([]);
    expect(now.excluded).toEqual([
      {
        id: "800",
        name: "Dana Dated",
        reason: "id",
        hiddenFrom: "2026-11-09",
        alsoMatchesPattern: false,
        hasRates: true,
      },
    ]);
    // The day before the hide week, the same driver was active.
    expect(buildDriverRoster({ ...input, asOf: "2026-11-08" }).active.map((d) => d.id)).toEqual([
      "800",
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
      asOf: TODAY,
    });
    expect(active).toEqual([
      { id: "200", name: "Evan Events", source: "events" },
      { id: "300", name: "Riley Rates", source: "rates" },
    ]);
  });

  it("lists every hidden id (legacy and dated), naming from Samsara, then events, then rates, then the id", () => {
    const { excluded } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [{ id: "1", name: "Samsara Name" }],
      events: [
        { driver_id: "1", driver_name: "Event Name" },
        { driver_id: "2", driver_name: "Only Events" },
      ],
      rates: [{ driver_id: "3", driver_name: "Only Rates" }],
      settings: {
        excludedDriverIds: ["1", "2", "4", "4"],
        excludedDriverNamePatterns: [],
        excludedDrivers: [{ id: "3", hiddenFrom: "2026-11-09" }],
      },
      asOf: TODAY,
    });
    expect(excluded.map((d) => [d.id, d.name, d.hiddenFrom])).toEqual([
      ["4", "4", null],
      ["2", "Only Events", null],
      ["3", "Only Rates", "2026-11-09"],
      ["1", "Samsara Name", null],
    ]);
  });

  it("flags an id-hidden driver that also matches a name pattern", () => {
    const { excluded } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [{ id: "900", name: "Test Hub Warehouse 2" }],
      events: [],
      rates: [],
      settings,
      asOf: TODAY,
    });
    expect(excluded[0]).toMatchObject({ id: "900", reason: "id", alsoMatchesPattern: true });
  });

  it("pattern-only exclusions surface only when they carry rate history", () => {
    const { active, excluded } = buildDriverRoster({
      rosterActive: [],
      rosterAll: [],
      events: [{ driver_id: "500", driver_name: "Test Hub Warehouse" }],
      rates: [{ driver_id: "600", driver_name: "Test Hub Warehouse B" }],
      settings: {
        excludedDriverIds: [],
        excludedDriverNamePatterns: ["Test Hub Warehouse"],
        excludedDrivers: [],
      },
      asOf: TODAY,
    });
    expect(active).toEqual([]);
    expect(excluded).toEqual([
      {
        id: "600",
        name: "Test Hub Warehouse B",
        reason: "pattern",
        hiddenFrom: null,
        alsoMatchesPattern: true,
        hasRates: true,
      },
    ]);
  });

  it("renders the planned production state: three legacy ids, two hub patterns", () => {
    const { active, excluded } = buildDriverRoster({
      rosterActive: [
        { id: "58143755", name: "Shared Login" },
        { id: "55836799", name: "Person A" },
        { id: "53332924", name: "Person B" },
        { id: "111", name: "Person C" },
      ],
      rosterAll: [
        { id: "58143755", name: "Shared Login" },
        { id: "55836799", name: "Person A" },
        { id: "53332924", name: "Person B" },
        { id: "111", name: "Person C" },
      ],
      events: [],
      rates: [],
      settings: {
        excludedDriverIds: ["58143755", "55836799", "53332924"],
        excludedDriverNamePatterns: ["Birmingham LTL", "Birmingham Warehouse"],
        excludedDrivers: [],
      },
      asOf: TODAY,
    });
    expect(active.map((d) => d.id)).toEqual(["111"]);
    expect(excluded.map((d) => [d.id, d.hiddenFrom, d.alsoMatchesPattern])).toEqual([
      ["55836799", null, false],
      ["53332924", null, false],
      ["58143755", null, false],
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

  it("hide adds a dated entry and preserves every other key exactly as saved", () => {
    const next = nextDriverTimeValue(saved, "123", true, entry);
    expect(next.changed).toBe(true);
    expect(next.value).toEqual({
      ...saved,
      excludedDrivers: [{ id: "123", ...entry }],
    });
    // Legacy ids and defaults are never rewritten.
    expect(next.value.excludedDriverIds).toEqual(["900"]);
    expect(next.value.excludedDriverNamePatterns).toEqual(["Test Hub LTL"]);
    expect(saved).not.toHaveProperty("excludedDrivers");
  });

  it("hide is idempotent for dated and legacy hides", () => {
    const once = nextDriverTimeValue(saved, "123", true, entry);
    const twice = nextDriverTimeValue(once.value, "123", true, {
      ...entry,
      hiddenFrom: "2026-11-16",
    });
    expect(twice.changed).toBe(false);
    expect(twice.value).toEqual(once.value);
    expect(nextDriverTimeValue(saved, "900", true, entry).changed).toBe(false);
  });

  it("restore removes the id from both lists, is idempotent, and preserves every other key", () => {
    const both = {
      ...saved,
      excludedDrivers: [
        { id: "900", hiddenFrom: "2026-11-09" },
        { id: "5", hiddenFrom: "2026-11-02" },
      ],
    };
    const restored = nextDriverTimeValue(both, "900", false, entry);
    expect(restored.changed).toBe(true);
    expect(restored.value).toEqual({
      ...saved,
      excludedDriverIds: [],
      excludedDrivers: [{ id: "5", hiddenFrom: "2026-11-02" }],
    });
    expect(nextDriverTimeValue(restored.value, "900", false, entry).changed).toBe(false);
  });

  it("restore of a legacy-only hide does not add an excludedDrivers key", () => {
    const restored = nextDriverTimeValue(saved, "900", false, entry);
    expect(restored.value).toEqual({ ...saved, excludedDriverIds: [] });
  });

  it("numeric ids in the saved row match their string form", () => {
    expect(nextDriverTimeValue({ excludedDriverIds: [900] }, "900", true, entry).changed).toBe(
      false,
    );
    expect(nextDriverTimeValue({ excludedDriverIds: [900] }, "900", false, entry).value).toEqual({
      excludedDriverIds: [],
    });
    expect(
      nextDriverTimeValue(
        { excludedDrivers: [{ id: 900, hiddenFrom: "2026-11-09" }] },
        "900",
        true,
        entry,
      ).changed,
    ).toBe(false);
  });

  it("a missing row or missing key starts an empty list", () => {
    expect(nextDriverTimeValue(null, "1", true, entry).value).toEqual({
      excludedDrivers: [{ id: "1", ...entry }],
    });
    expect(nextDriverTimeValue({ basis: "presence" }, "1", true, entry).value).toEqual({
      basis: "presence",
      excludedDrivers: [{ id: "1", ...entry }],
    });
  });

  it("refuses a malformed row instead of overwriting it", () => {
    expect(() => nextDriverTimeValue([], "1", true, entry)).toThrow(/expected shape/);
    expect(() => nextDriverTimeValue("x", "1", true, entry)).toThrow(/expected shape/);
    expect(() => nextDriverTimeValue({ excludedDriverIds: "900" }, "1", true, entry)).toThrow(
      /not a list/,
    );
    expect(() => nextDriverTimeValue({ excludedDrivers: {} }, "1", true, entry)).toThrow(
      /not a list/,
    );
  });

  it("caps the hidden list across legacy and dated entries", () => {
    const half = MAX_EXCLUDED_DRIVER_IDS / 2;
    const full = {
      excludedDriverIds: Array.from({ length: half }, (_, i) => `${i}`),
      excludedDrivers: Array.from({ length: half }, (_, i) => ({
        id: `d${i}`,
        hiddenFrom: "2026-11-09",
      })),
    };
    expect(() => nextDriverTimeValue(full, "new", true, entry)).toThrow(/At most/);
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

describe("scopeWeekInputs", () => {
  const ev = (
    driver_id: string,
    event_date: string,
    driver_name = `Driver ${driver_id}`,
    hub = "Hub A",
  ) => ({
    driver_id,
    driver_name,
    event_date,
    hub,
  });
  const official = (driver_id: string, driverName: string, hub = "Hub A") => ({
    driver_id,
    warehouse_actual: { driverName, hub, minutes: 120 },
  });

  it("drops id-hidden events and official totals and counts them", () => {
    const out = scopeWeekInputs({
      events: [ev("900", "2026-11-10"), ev("900", "2026-11-11"), ev("1", "2026-11-10")],
      overrides: [
        official("900", "Driver 900"),
        official("1", "Driver 1"),
        { driver_id: "900", warehouse_actual: null },
      ],
      settings,
      weekStart: "2026-11-09",
    });
    expect(out.events.map((e) => e.driver_id)).toEqual(["1"]);
    expect(out.overrides.map((o) => [o.driver_id, o.warehouse_actual != null])).toEqual([
      ["1", true],
      ["900", false],
    ]);
    expect(out.hidden).toEqual({ drivers: 1, events: 2, officialTotals: 1 });
  });

  it("counts an official-only hidden driver with no events", () => {
    const out = scopeWeekInputs({
      events: [],
      overrides: [official("900", "Driver 900")],
      settings,
      weekStart: "2026-11-09",
    });
    expect(out.overrides).toEqual([]);
    expect(out.hidden).toEqual({ drivers: 1, events: 0, officialTotals: 1 });
  });

  it("keeps a dated-hidden driver's events and official total in weeks before hiddenFrom", () => {
    const dated = {
      ...settings,
      excludedDriverIds: [],
      excludedDrivers: [{ id: "800", hiddenFrom: "2026-11-09" }],
    };
    const before = scopeWeekInputs({
      events: [ev("800", "2026-11-06")],
      overrides: [official("800", "Driver 800")],
      settings: dated,
      weekStart: "2026-11-02",
    });
    expect(before.events).toHaveLength(1);
    expect(before.overrides).toHaveLength(1);
    expect(before.hidden).toEqual({ drivers: 0, events: 0, officialTotals: 0 });
    const on = scopeWeekInputs({
      events: [ev("800", "2026-11-09")],
      overrides: [official("800", "Driver 800")],
      settings: dated,
      weekStart: "2026-11-09",
    });
    expect(on.events).toEqual([]);
    expect(on.overrides).toEqual([]);
    expect(on.hidden).toEqual({ drivers: 1, events: 1, officialTotals: 1 });
  });

  it("drops a report-identity official total that joins to a hidden driver by exact name and hub", () => {
    const out = scopeWeekInputs({
      events: [ev("900", "2026-11-10", "Harper  Hidden")],
      overrides: [
        official("report:hub a:harper-hidden", "harper hidden"),
        official("report:hub b:harper-hidden", "Harper Hidden", "Hub B"),
      ],
      settings,
      weekStart: "2026-11-09",
    });
    expect(out.overrides.map((o) => o.driver_id)).toEqual(["report:hub b:harper-hidden"]);
    expect(out.hidden).toEqual({ drivers: 1, events: 1, officialTotals: 1 });
  });

  it("drops pattern-matched events and official totals without counting them", () => {
    const out = scopeWeekInputs({
      events: [ev("500", "2026-11-10", "Test Hub Warehouse")],
      overrides: [official("500", "Test Hub Warehouse")],
      settings,
      weekStart: "2026-11-09",
    });
    expect(out.events).toEqual([]);
    expect(out.overrides).toEqual([]);
    expect(out.hidden).toEqual({ drivers: 0, events: 0, officialTotals: 0 });
  });
});

describe("hiddenRosterNotice", () => {
  it("says so in plain words, and nothing when no one is hidden", () => {
    expect(hiddenRosterNotice({ drivers: 0, events: 0, officialTotals: 0 })).toBeNull();
    expect(hiddenRosterNotice(undefined)).toBeNull();
    expect(hiddenRosterNotice({ drivers: 1, events: 1, officialTotals: 0 })).toMatch(
      /^1 driver hidden from the roster has 1 warehouse event in this window\. They are not in this report or the estimated cost\. Weeks before a driver was hidden still include them\./,
    );
    expect(hiddenRosterNotice({ drivers: 2, events: 5, officialTotals: 1 })).toMatch(
      /^2 drivers .* have 5 warehouse events and 1 official weekly total in this window/,
    );
    expect(hiddenRosterNotice({ drivers: 1, events: 0, officialTotals: 2 })).toMatch(
      /^1 driver hidden from the roster has 2 official weekly totals in this window/,
    );
  });
});
