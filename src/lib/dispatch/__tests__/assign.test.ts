import { describe, expect, it } from "vitest";
import { assignRun, splitDateTime, type AssignCutoff } from "../assign";

const C = (p21_code: string, cutoff_dow: number, cutoff_time: string, run_dows: number[]): AssignCutoff => ({ p21_code, cutoff_dow, cutoff_time, run_dows });
// Mirrors live route_cutoffs rows (2026-09-28).
const MOAR1 = [C("MOAR1", 1, "12:00:00", [2])];
const JAX01 = [C("JAX01", 5, "13:00:00", [1])];
const MSL01 = [C("MSL01", 2, "13:00:00", [3, 4])];
const WTX01 = [C("WTX01", 4, "12:00:00", [1, 2])];
const DAL01 = [1, 2, 3, 4, 5].map((d) => C("DAL01", d, "15:00:00", [d === 5 ? 1 : d + 1]));
const TODAY = "2026-09-28";

describe("assignRun", () => {
  it("MOAR1 printed Mon 9/28 -> Tue 9/29", () => expect(assignRun("2026-09-28", MOAR1, TODAY)).toMatchObject({ status: "assigned", runDate: "2026-09-29" }));
  it("JAX01 printed Thu 9/24 -> Mon 9/28", () => expect(assignRun("2026-09-24", JAX01, TODAY)).toMatchObject({ status: "assigned", runDate: "2026-09-28" }));
  it("MSL01 printed Mon 9/28 -> Wed 9/30", () => expect(assignRun("2026-09-28", MSL01, TODAY)).toMatchObject({ status: "assigned", runDate: "2026-09-30" }));
  it("WTX01 printed Wed 9/23 -> Mon 9/28", () => expect(assignRun("2026-09-23", WTX01, TODAY)).toMatchObject({ status: "assigned", runDate: "2026-09-28" }));
  it("DAL01 printed 5/19 -> stale", () => expect(assignRun("2026-05-19", DAL01, TODAY)).toMatchObject({ status: "stale", runDate: "2026-05-20" }));
  it("route with no cutoff -> unassigned", () => expect(assignRun("2026-09-28", [], TODAY)).toEqual({ status: "no_cutoff" }));
  it("midnight timestamp is date-only; late timestamp misses same-day cutoff", () => {
    expect(assignRun("2026-09-28T00:00:00", MOAR1, TODAY)).toMatchObject({ runDate: "2026-09-29" });
    expect(assignRun("2026-09-28T14:30:00", MOAR1, TODAY)).toMatchObject({ runDate: "2026-10-06" });
  });
  it("null date -> no_date", () => expect(assignRun(null, MOAR1, TODAY)).toEqual({ status: "no_date" }));
  it("splitDateTime", () => expect(splitDateTime("2026-09-28 13:05:00.000")).toEqual({ date: "2026-09-28", time: "13:05" }));
});

describe("assignRun with run exceptions", () => {
  const NR = (run_date: string, reason: "short_week" | "driver_pto" | "other" = "driver_pto") => ({ run_date, reason });
  it("MOAR1 Mon 10/05, no_run Tue 10/06 -> Tue 10/13", () =>
    expect(assignRun("2026-10-05", MOAR1, TODAY, [NR("2026-10-06")])).toEqual({ status: "assigned", runDate: "2026-10-13", cutoffDate: "2026-10-05", rolledFrom: { runDate: "2026-10-06", reason: "driver_pto" } }));
  it("DAL01 Mon 10/05, no_run Tue 10/06 -> Wed 10/07", () =>
    expect(assignRun("2026-10-05", DAL01, TODAY, [NR("2026-10-06")])).toMatchObject({ runDate: "2026-10-07", rolledFrom: { runDate: "2026-10-06" } }));
  it("DAL01 no_run Tue + Wed -> Thu 10/08", () =>
    expect(assignRun("2026-10-05", DAL01, TODAY, [NR("2026-10-06"), NR("2026-10-07", "short_week")])).toMatchObject({ runDate: "2026-10-08", rolledFrom: { runDate: "2026-10-06", reason: "driver_pto" } }));
  it("MSL01 Mon 10/05, no_run Wed 10/07 -> Thu 10/08", () =>
    expect(assignRun("2026-10-05", MSL01, TODAY, [NR("2026-10-07")])).toMatchObject({ runDate: "2026-10-08", rolledFrom: { runDate: "2026-10-07" } }));
  it("reduced (not passed as no_run) leaves MOAR1 on 10/06", () => {
    const a = assignRun("2026-10-05", MOAR1, TODAY, []);
    expect(a).toMatchObject({ runDate: "2026-10-06" });
    expect((a as any).rolledFrom).toBeUndefined();
  });
  it("nothing within 60 days -> no_cutoff", () => {
    const all = Array.from({ length: 12 }, (_, i) => NR(new Date(Date.UTC(2026, 9, 6 + 7 * i)).toISOString().slice(0, 10)));
    expect(assignRun("2026-10-05", MOAR1, TODAY, all)).toEqual({ status: "no_cutoff" });
  });
  it("no exceptions -> identical to today for existing cases", () => {
    for (const [d, c] of [["2026-09-28", MOAR1], ["2026-09-24", JAX01], ["2026-09-28", MSL01], ["2026-09-23", WTX01], ["2026-05-19", DAL01], ["2026-09-28T14:30:00", MOAR1], [null, MOAR1]] as const)
      expect(assignRun(d, c as any, TODAY, [])).toEqual(assignRun(d, c as any, TODAY));
  });
});
