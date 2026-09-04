import { describe, it, expect } from "vitest";
import { runDatesInWindow, rollForward } from "../roll-forward";
import type { RouteCutoff } from "../cutoffs";

const CHI = "America/Chicago";

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

// ETX-style: Tue 3pm CT feeds Thu/Fri; Fri 3pm CT feeds Mon/Tue.
const ETX = [
  cut({ p21_code: "ETX01", cutoff_dow: 2, cutoff_time: "15:00", run_dows: [4, 5] }),
  cut({ p21_code: "ETX01", cutoff_dow: 5, cutoff_time: "15:00", run_dows: [1, 2] }),
];

describe("runDatesInWindow / rollForward — ETX before Friday cutoff", () => {
  const now = new Date("2026-09-04T19:50:00Z"); // Fri 2:50pm CT
  const dates = runDatesInWindow(ETX, now);

  it("starts with Mon/Tue (from today's Fri cutoff) then Thu/Fri", () => {
    expect(dates.slice(0, 4)).toEqual(["2026-09-07", "2026-09-08", "2026-09-10", "2026-09-11"]);
  });

  it("rolls today's backlog to Monday 09-07", () => {
    expect(rollForward("2026-09-04", dates)).toBe("2026-09-07");
  });

  it("rolls a Wednesday date to Thursday 09-10", () => {
    expect(rollForward("2026-09-09", dates)).toBe("2026-09-10");
  });

  it("leaves a date that is already a run date alone", () => {
    expect(rollForward("2026-09-10", dates)).toBe("2026-09-10");
  });
});

describe("ETX after Friday cutoff", () => {
  const now = new Date("2026-09-04T20:10:00Z"); // Fri 3:10pm CT
  const dates = runDatesInWindow(ETX, now);

  it("drops the Mon/Tue run — first reachable dates are Thu/Fri", () => {
    expect(dates.slice(0, 2)).toEqual(["2026-09-10", "2026-09-11"]);
  });

  it("rolls today's backlog to Thursday 09-10", () => {
    expect(rollForward("2026-09-04", dates)).toBe("2026-09-10");
  });
});

describe("edge cases", () => {
  const now = new Date("2026-09-04T19:50:00Z");

  it("no cutoffs: empty window, ship date unchanged", () => {
    expect(runDatesInWindow([], now)).toEqual([]);
    expect(rollForward("2026-09-04", [])).toBe("2026-09-04");
  });

  it("a ship date beyond every run date is returned unchanged", () => {
    const dates = runDatesInWindow(ETX, now, 7);
    expect(dates.length).toBeGreaterThan(0);
    expect(rollForward("2027-01-15", dates)).toBe("2027-01-15");
  });

  it("inactive cutoffs are ignored", () => {
    const off = [cut({ cutoff_dow: 2, cutoff_time: "15:00", run_dows: [4, 5], active: false })];
    expect(runDatesInWindow(off, now)).toEqual([]);
    expect(runDatesInWindow([...off, ETX[1]!], now).slice(0, 2)).toEqual(["2026-09-07", "2026-09-08"]);
  });
});
