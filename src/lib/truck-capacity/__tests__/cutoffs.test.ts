import { describe, it, expect } from "vitest";
import {
  nextCutoff, nextOccurrence, runDatesFor, runsWeekend, cutoffSortKey,
  zonedWallToUtc, tzOffsetMinutes, localDateIn, formatTimeLabel,
  type RouteCutoff,
} from "../cutoffs";

const CHI = "America/Chicago";
const NY = "America/New_York";

function cut(p: Partial<RouteCutoff> & { cutoff_dow: number; cutoff_time: string }): RouteCutoff {
  return {
    id: p.id ?? `c-${p.cutoff_dow}-${p.cutoff_time}`,
    route_id: p.route_id ?? "r1",
    p21_code: p.p21_code ?? null,
    cutoff_dow: p.cutoff_dow,
    cutoff_time: p.cutoff_time,
    tz: p.tz ?? CHI,
    run_dows: p.run_dows ?? [],
    run_days_label: p.run_days_label ?? null,
    driver_name: p.driver_name ?? null,
    notes: p.notes ?? null,
    sort_order: p.sort_order ?? 0,
    active: p.active ?? true,
  };
}

// MTN01 Tue 4pm (runs Wed/Thu) + MTN02 Thu 5pm (runs Mon/Tue), both CST.
const MTN01 = cut({ p21_code: "MTN01", cutoff_dow: 2, cutoff_time: "16:00", run_dows: [3, 4] });
const MTN02 = cut({ p21_code: "MTN02", cutoff_dow: 4, cutoff_time: "17:00", run_dows: [1, 2] });

// Dallas locals: every weekday 3pm, next-day delivery (Fri -> Mon).
const DAL01 = [1, 2, 3, 4, 5].map((d) =>
  cut({ p21_code: "DAL01", cutoff_dow: d, cutoff_time: "15:00", run_dows: [d === 5 ? 1 : d + 1] }),
);

describe("tz primitives", () => {
  it("resolves CST and CDT offsets", () => {
    expect(tzOffsetMinutes(CHI, new Date("2026-01-15T18:00:00Z"))).toBe(-360); // CST
    expect(tzOffsetMinutes(CHI, new Date("2026-07-15T18:00:00Z"))).toBe(-300); // CDT
  });

  it("converts wall clock to UTC across the DST boundary", () => {
    // 2026-03-08 is the US spring-forward date. Tue 4pm before -> CST (22:00Z),
    // after -> CDT (21:00Z).
    expect(zonedWallToUtc("2026-03-03", "16:00", CHI).toISOString()).toBe("2026-03-03T22:00:00.000Z");
    expect(zonedWallToUtc("2026-03-10", "16:00", CHI).toISOString()).toBe("2026-03-10T21:00:00.000Z");
  });

  it("gives the local calendar date, not the UTC one", () => {
    // 03:00Z Wed is still Tue evening in Chicago.
    expect(localDateIn(CHI, new Date("2026-08-12T03:00:00Z"))).toBe("2026-08-11");
  });

  it("formats 12-hour labels", () => {
    expect(formatTimeLabel("16:00")).toBe("4:00p");
    expect(formatTimeLabel("10:30")).toBe("10:30a");
    expect(formatTimeLabel("12:00")).toBe("12:00p");
  });
});

describe("nextCutoff — multi-cutoff routes (MTN01 + MTN02)", () => {
  const cutoffs = [MTN01, MTN02];

  it("picks Tue 4pm when asked on Monday", () => {
    const n = nextCutoff(cutoffs, new Date("2026-08-10T14:00:00Z"))!; // Mon 9am CDT
    expect(n.cutoff.p21_code).toBe("MTN01");
    expect(n.localDate).toBe("2026-08-11");
    expect(n.timeLabel).toBe("Tue 4:00p");
    expect(n.daysAway).toBe(1);
    expect(n.isTomorrow).toBe(true);
    expect(n.runDates).toEqual(["2026-08-12", "2026-08-13"]);
    expect(n.label).toBe("Orders counted through Tue 4:00p (Wed–Thu run)");
  });

  it("rolls to Thu 5pm once Tue 4pm has passed", () => {
    const n = nextCutoff(cutoffs, new Date("2026-08-11T21:30:00Z"))!; // Tue 4:30pm CDT
    expect(n.cutoff.p21_code).toBe("MTN02");
    expect(n.localDate).toBe("2026-08-13");
    expect(n.runDates).toEqual(["2026-08-17", "2026-08-18"]); // next Mon/Tue
  });

  it("wraps to next week's Tue after Thu 5pm", () => {
    const n = nextCutoff(cutoffs, new Date("2026-08-13T23:00:00Z"))!; // Thu 6pm CDT
    expect(n.cutoff.p21_code).toBe("MTN01");
    expect(n.localDate).toBe("2026-08-18");
    expect(n.daysAway).toBe(5);
  });

  it("treats the cutoff instant itself as passed", () => {
    const atCutoff = zonedWallToUtc("2026-08-11", "16:00", CHI);
    const n = nextCutoff([MTN01], atCutoff)!;
    expect(n.localDate).toBe("2026-08-18");
  });
});

describe("nextCutoff — timezone differences", () => {
  it("EST route cuts off an hour earlier in UTC than the CST route", () => {
    const chi = cut({ cutoff_dow: 5, cutoff_time: "13:00", tz: CHI, run_dows: [1] });
    const ny = cut({ cutoff_dow: 5, cutoff_time: "13:00", tz: NY, run_dows: [1] });
    const now = new Date("2026-08-12T12:00:00Z"); // Wed
    const a = nextCutoff([chi], now)!;
    const b = nextCutoff([ny], now)!;
    expect(a.atUtc.toISOString()).toBe("2026-08-14T18:00:00.000Z");
    expect(b.atUtc.toISOString()).toBe("2026-08-14T17:00:00.000Z");
    expect(b.atUtc.getTime()).toBeLessThan(a.atUtc.getTime());
  });

  it("handles a winter EST cutoff (no DST)", () => {
    const ny = cut({ cutoff_dow: 5, cutoff_time: "13:00", tz: NY, run_dows: [1] });
    const n = nextCutoff([ny], new Date("2026-01-14T12:00:00Z"))!;
    expect(n.atUtc.toISOString()).toBe("2026-01-16T18:00:00.000Z");
  });
});

describe("nextCutoff — DAL01 daily locals", () => {
  it("gives the same-day 3pm cutoff in the morning", () => {
    const n = nextCutoff(DAL01, new Date("2026-08-12T13:00:00Z"))!; // Wed 8am CDT
    expect(n.localDate).toBe("2026-08-12");
    expect(n.isToday).toBe(true);
    expect(n.runDates).toEqual(["2026-08-13"]);
  });

  it("rolls to tomorrow's cutoff after 3pm", () => {
    const n = nextCutoff(DAL01, new Date("2026-08-12T20:30:00Z"))!; // Wed 3:30pm CDT
    expect(n.localDate).toBe("2026-08-13");
  });

  it("Friday's cutoff ships Monday", () => {
    const n = nextCutoff(DAL01, new Date("2026-08-14T13:00:00Z"))!; // Fri morning
    expect(n.localDate).toBe("2026-08-14");
    expect(n.runDates).toEqual(["2026-08-17"]);
  });

  it("Saturday rolls to Monday's cutoff", () => {
    const n = nextCutoff(DAL01, new Date("2026-08-15T18:00:00Z"))!; // Sat
    expect(n.localDate).toBe("2026-08-17");
    expect(n.daysAway).toBe(2);
  });
});

describe("weekend suppression", () => {
  it("is false for weekday-only routes", () => {
    expect(runsWeekend([MTN01, MTN02])).toBe(false);
    expect(runsWeekend(DAL01)).toBe(false);
  });

  it("is true when a cutoff or run day lands on Sat/Sun", () => {
    expect(runsWeekend([cut({ cutoff_dow: 5, cutoff_time: "12:00", run_dows: [6] })])).toBe(true);
    expect(runsWeekend([cut({ cutoff_dow: 6, cutoff_time: "12:00", run_dows: [1] })])).toBe(true);
  });

  it("ignores inactive cutoffs", () => {
    expect(runsWeekend([cut({ cutoff_dow: 6, cutoff_time: "12:00", run_dows: [0], active: false })])).toBe(false);
  });
});

describe("edge cases", () => {
  it("zero-cutoff routes return null and sort last", () => {
    const n = nextCutoff([], new Date("2026-08-12T12:00:00Z"));
    expect(n).toBeNull();
    expect(cutoffSortKey(n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("inactive cutoffs are skipped entirely", () => {
    const off = cut({ cutoff_dow: 2, cutoff_time: "16:00", active: false });
    expect(nextOccurrence(off, new Date("2026-08-10T14:00:00Z"))).toBeNull();
    expect(nextCutoff([off], new Date("2026-08-10T14:00:00Z"))).toBeNull();
  });

  it("a cutoff with no run days yields an empty window", () => {
    const n = nextCutoff([cut({ cutoff_dow: 2, cutoff_time: "16:00", run_dows: [] })], new Date("2026-08-10T14:00:00Z"))!;
    expect(n.runDates).toEqual([]);
    expect(n.windowFrom).toBeNull();
    expect(n.label).toBe("Orders counted through Tue 4:00p");
  });

  it("runDatesFor never returns the cutoff day itself", () => {
    // Tue cutoff that also 'runs Tue' means next Tue, not today.
    expect(runDatesFor(cut({ cutoff_dow: 2, cutoff_time: "16:00", run_dows: [2] }), "2026-08-11"))
      .toEqual(["2026-08-18"]);
  });

  it("accepts HH:MM:SS times from Postgres", () => {
    const n = nextCutoff([cut({ cutoff_dow: 2, cutoff_time: "16:00:00", run_dows: [3] })], new Date("2026-08-10T14:00:00Z"))!;
    expect(n.atUtc.toISOString()).toBe("2026-08-11T21:00:00.000Z");
    expect(n.timeLabel).toBe("Tue 4:00p");
  });

  it("sorts a today cutoff ahead of a tomorrow cutoff", () => {
    const now = new Date("2026-08-12T13:00:00Z");
    const today = nextCutoff([cut({ cutoff_dow: 3, cutoff_time: "15:00", run_dows: [4] })], now);
    const tomorrow = nextCutoff([cut({ cutoff_dow: 4, cutoff_time: "15:00", run_dows: [5] })], now);
    expect(cutoffSortKey(today)).toBeLessThan(cutoffSortKey(tomorrow));
  });
});

describe("run-days wording (Joe, 2026-08-26: 'Runs column has some weird wording')", () => {
  const at = new Date("2026-08-10T14:00:00Z"); // Mon

  const labelFor = (run_dows: number[]) =>
    nextCutoff([cut({ cutoff_dow: 2, cutoff_time: "16:00", run_dows })], at)!.label;

  it("single run day keeps the bare form", () => {
    expect(labelFor([3])).toBe("Orders counted through Tue 4:00p (Wed run)");
  });

  it("two consecutive run days stay an en-dash range", () => {
    expect(labelFor([3, 4])).toBe("Orders counted through Tue 4:00p (Wed\u2013Thu run)");
  });

  it("two non-consecutive run days use an ampersand, not a range", () => {
    expect(labelFor([1, 3])).toBe("Orders counted through Tue 4:00p (Mon & Wed run)");
  });

  it("three non-consecutive run days use a comma list, not a range", () => {
    expect(labelFor([1, 3, 5])).toBe("Orders counted through Tue 4:00p (Mon, Wed, Fri run)");
  });

  it("three consecutive run days may still collapse to a range", () => {
    expect(labelFor([3, 4, 5])).toBe("Orders counted through Tue 4:00p (Wed\u2013Fri run)");
  });
});
