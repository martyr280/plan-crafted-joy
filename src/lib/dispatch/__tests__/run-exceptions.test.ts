import { describe, expect, it } from "vitest";
import type { AssignCutoff } from "../assign";
import { planRunBuild, pushBlockedReason, runFlag, type RunException } from "../run-exceptions";
import { buildDispatchBoard } from "../board";

const C = (p21_code: string, cutoff_dow: number, cutoff_time: string, run_dows: number[]): AssignCutoff => ({ p21_code, cutoff_dow, cutoff_time, run_dows });
const DAL01 = [1, 2, 3, 4, 5].map((d) => C("DAL01", d, "15:00:00", [d === 5 ? 1 : d + 1]));
const TODAY = "2026-10-01";
const PTO: RunException = { p21_code: "DAL01", run_date: "2026-10-06", kind: "no_run", reason: "driver_pto", note: null };
const rows = [
  { pick_ticket_no: "T-MON", pick_ticket_print_date: "2026-10-05" }, // -> Tue 10/06
  { pick_ticket_no: "T-TUE", pick_ticket_print_date: "2026-10-06" }, // -> Wed 10/07
];

describe("planRunBuild (run exceptions)", () => {
  it("skips a no_run route/date with the roll message", () => {
    const p = planRunBuild({ rows, dateColumn: "pick_ticket_print_date", cutoffs: DAL01, p21Code: "DAL01", runDates: ["2026-10-06"], today: TODAY, exceptions: [PTO] });
    expect(p.build).toEqual([]);
    expect(p.skipped).toEqual([{ runDate: "2026-10-06", message: "No run on Tue, Oct 6 — Driver PTO. Tickets roll to Wed, Oct 7." }]);
  });

  it("includes the rolled ticket on the next run's build", () => {
    const p = planRunBuild({ rows, dateColumn: "pick_ticket_print_date", cutoffs: DAL01, p21Code: "DAL01", runDates: ["2026-10-07"], today: TODAY, exceptions: [PTO] });
    expect(p.build).toHaveLength(1);
    expect(p.build[0].rows.map((r) => r.pick_ticket_no).sort()).toEqual(["T-MON", "T-TUE"]);
  });

  it("without the exception the Monday ticket stays on Tuesday", () => {
    const p = planRunBuild({ rows, dateColumn: "pick_ticket_print_date", cutoffs: DAL01, p21Code: "DAL01", runDates: ["2026-10-06"], today: TODAY, exceptions: [] });
    expect(p.build[0].rows.map((r) => r.pick_ticket_no)).toEqual(["T-MON"]);
  });

  it("reduced builds as normal with the flag", () => {
    const red: RunException = { ...PTO, kind: "reduced", reason: "short_week", note: "one truck" };
    const p = planRunBuild({ rows, dateColumn: "pick_ticket_print_date", cutoffs: DAL01, p21Code: "DAL01", runDates: ["2026-10-06"], today: TODAY, exceptions: [red] });
    expect(p.skipped).toEqual([]);
    expect(p.build[0]).toMatchObject({ runDate: "2026-10-06", reduced: "Reduced — Short week: one truck" });
    expect(p.build[0].rows.map((r) => r.pick_ticket_no)).toEqual(["T-MON"]);
    expect(runFlag([red], "DAL01", "2026-10-06", DAL01)).toMatchObject({ kind: "reduced", badge: "Reduced — Short week: one truck" });
    expect(pushBlockedReason([red], "DAL01", "2026-10-06", DAL01)).toBeNull();
  });

  it("push is blocked for a no_run draft; other dates/routes are not", () => {
    expect(pushBlockedReason([PTO], "dal01", "2026-10-06", DAL01)).toBe("No run on Tue, Oct 6 — Driver PTO. Tickets roll to Wed, Oct 7.");
    expect(runFlag([PTO], "DAL01", "2026-10-06", DAL01)).toMatchObject({ kind: "no_run", badge: "Run cancelled (exception)" });
    expect(pushBlockedReason([PTO], "DAL01", "2026-10-07", DAL01)).toBeNull();
    expect(pushBlockedReason([PTO], "MOAR1", "2026-10-06", DAL01)).toBeNull();
  });
});

describe("builder and Tickets-by-cutoff board agree", () => {
  it("same run date for every ticket (both call assignRun with exceptions)", () => {
    const board = buildDispatchBoard(
      rows.map((r) => ({ ...r, route_code: "DAL01" })) as any,
      DAL01.map((c) => ({ ...c, route_id: "r1", active: true })) as any,
      [],
      { basis: "pick_ticket_print", today: TODAY, excludedCodes: [], exceptions: [PTO] as any },
    );
    const plan = planRunBuild({ rows, dateColumn: "pick_ticket_print_date", cutoffs: DAL01, p21Code: "DAL01", runDates: ["2026-10-06", "2026-10-07"], today: TODAY, exceptions: [PTO] });
    const planned = new Map(plan.build.flatMap((b) => b.rows.map((r) => [r.pick_ticket_no, b.runDate])));
    const json = JSON.stringify(board);
    expect(planned.get("T-MON")).toBe("2026-10-07");
    expect(json).toContain("2026-10-07");
  });
});
