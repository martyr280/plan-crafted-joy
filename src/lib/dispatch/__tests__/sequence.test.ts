import { describe, expect, it } from "vitest";
import {
  dowFromLabel,
  runDateForStop,
  sequenceStops,
  wallTimeFor,
  type SequenceStopInput,
  type SequenceTemplateRow,
} from "../sequence";

const CHI = "America/Chicago";
const NY = "America/New_York";

function stop(id: string, city: string, state: string, zip: string, name: string): SequenceStopInput {
  return { id, city, state, zip, customerName: name };
}

// MSL01-style template: Missouri run delivering Wed and Thu.
const MSL01_TEMPLATE: SequenceTemplateRow[] = [
  { city_norm: "SPRINGFIELD", state: "MO", position: 1, delivery_dow_label: "Wed" },
  { city_norm: "BRANSON", state: "MO", position: 2, delivery_dow_label: "Wed" },
  { city_norm: "COLUMBIA", state: "MO", position: 1, delivery_dow_label: "Thu" },
  { city_norm: "JEFFERSON CITY", state: "MO", position: 2, delivery_dow_label: "Thu" },
];

// 2026-08-26 is a Wednesday; 2026-08-27 a Thursday.
const WED = "2026-08-26";
const THU = "2026-08-27";

describe("dow labels", () => {
  it("parses short and long day names", () => {
    expect(dowFromLabel("Wed")).toBe(3);
    expect(dowFromLabel("wednesday")).toBe(3);
    expect(dowFromLabel("THU")).toBe(4);
    expect(dowFromLabel("")).toBeNull();
    expect(dowFromLabel("someday")).toBeNull();
  });

  it("falls back to the first run date when the label is unusable", () => {
    expect(runDateForStop(null, [WED, THU])).toBe(WED);
    expect(runDateForStop({ city_norm: "X", state: "MO", position: 1, delivery_dow_label: "Thu" }, [WED, THU])).toBe(THU);
  });
});

describe("wallTimeFor", () => {
  it("advances by the increment and rolls past midnight", () => {
    expect(wallTimeFor("07:00", 20, 1)).toEqual({ time: "07:20", dayOffset: 0 });
    expect(wallTimeFor("07:00", 20, 3)).toEqual({ time: "08:00", dayOffset: 0 });
    expect(wallTimeFor("23:30", 60, 1)).toEqual({ time: "00:30", dayOffset: 1 });
  });
});

describe("sequenceStops", () => {
  const stops = [
    stop("s-branson", "Branson", "MO", "65616", "Branson Furniture"),
    stop("s-jeff", "Jefferson City", "MO", "65101", "Capitol Office"),
    stop("s-spring", "Springfield", "MO", "65802", "Springfield Supply"),
    stop("s-columbia", "Columbia", "MO", "65201", "Columbia Interiors"),
  ];

  it("partitions a Wed+Thu run into one route per run day", () => {
    const days = sequenceStops(stops, MSL01_TEMPLATE, [WED, THU], {
      tz: CHI,
      depotDepartLocal: "07:00",
      stopIncrementMin: 20,
    });
    expect(days.map((d) => d.runDate)).toEqual([WED, THU]);
    expect(days[0]!.stops.map((s) => s.id)).toEqual(["s-spring", "s-branson"]);
    expect(days[1]!.stops.map((s) => s.id)).toEqual(["s-columbia", "s-jeff"]);
  });

  it("breaks a same-position tie by zip then customer name", () => {
    const tpl: SequenceTemplateRow[] = [
      { city_norm: "DALLAS", state: "TX", position: 1, delivery_dow_label: "Wed" },
    ];
    const same = [
      stop("b", "Dallas", "TX", "75201", "Zeta Office"),
      stop("a", "Dallas", "TX", "75201", "Alpha Office"),
      stop("c", "Dallas", "TX", "75001", "Middle Office"),
    ];
    const days = sequenceStops(same, tpl, [WED], { tz: CHI, depotDepartLocal: "07:00", stopIncrementMin: 15 });
    expect(days[0]!.stops.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("places unknown cities last in their day group and flags them unslotted", () => {
    const withUnknown = [...stops, stop("s-mystery", "Nowheresville", "MO", "65999", "Mystery Co")];
    const days = sequenceStops(withUnknown, MSL01_TEMPLATE, [WED, THU], {
      tz: CHI,
      depotDepartLocal: "07:00",
      stopIncrementMin: 20,
    });
    const wed = days[0]!.stops;
    expect(wed[wed.length - 1]!.id).toBe("s-mystery");
    expect(wed[wed.length - 1]!.unslotted).toBe(true);
    expect(wed.slice(0, -1).every((s) => s.unslotted === false)).toBe(true);
  });

  it("emits strictly increasing UTC arrival times within a day", () => {
    const days = sequenceStops(stops, MSL01_TEMPLATE, [WED, THU], {
      tz: CHI,
      depotDepartLocal: "07:00",
      stopIncrementMin: 20,
    });
    for (const day of days) {
      const times = day.stops.map((s) => Date.parse(s.scheduledArrival));
      for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
      expect(day.stops.every((s) => s.scheduledArrival.endsWith("Z"))).toBe(true);
    }
  });

  it("represents every run date even when it received no stops", () => {
    const days = sequenceStops([], MSL01_TEMPLATE, [WED, THU], {
      tz: CHI,
      depotDepartLocal: "07:00",
      stopIncrementMin: 20,
    });
    expect(days.map((d) => d.runDate)).toEqual([WED, THU]);
    expect(days.every((d) => d.stops.length === 0)).toBe(true);
  });

  describe("DST correctness", () => {
    const one = [stop("only", "Dallas", "TX", "75201", "Only Co")];
    const tpl: SequenceTemplateRow[] = [
      { city_norm: "DALLAS", state: "TX", position: 1, delivery_dow_label: null },
    ];

    // 2026 US DST: spring forward Mar 8, fall back Nov 1.
    const cases: Array<[string, string, string, number]> = [
      ["Chicago before spring forward", CHI, "2026-03-06", -6],
      ["Chicago after spring forward", CHI, "2026-03-10", -5],
      ["Chicago before fall back", CHI, "2026-10-30", -5],
      ["Chicago after fall back", CHI, "2026-11-03", -6],
      ["New York before spring forward", NY, "2026-03-06", -5],
      ["New York after spring forward", NY, "2026-03-10", -4],
      ["New York before fall back", NY, "2026-10-30", -4],
      ["New York after fall back", NY, "2026-11-03", -5],
    ];

    for (const [label, tz, date, offsetHours] of cases) {
      it(`stamps 07:20 local as the right UTC instant — ${label}`, () => {
        const days = sequenceStops(one, tpl, [date], { tz, depotDepartLocal: "07:00", stopIncrementMin: 20 });
        const at = new Date(days[0]!.stops[0]!.scheduledArrival);
        // 07:20 local == (7 - offset):20 UTC on the same date for these hours.
        expect(at.getUTCHours()).toBe(7 - offsetHours);
        expect(at.getUTCMinutes()).toBe(20);
        expect(at.toISOString().slice(0, 10)).toBe(date);
      });
    }
  });
});
