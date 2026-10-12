import { describe, expect, it } from "vitest";
import {
  latestPossibleForecastInstant,
  pickForecastAtCutoff,
  strictComparison,
  strictCutoffInstantForRun,
} from "../accuracy";
import { dateStrInTz } from "../../tz";

const logs = [{ made_on: "2026-09-07", served: 0.5, predicted: 0.5, method: "baseline" }];
const rule = (tz: string, time = "00:15") => [
  { cutoff_dow: 2, cutoff_time: time, tz, run_dows: [3] },
];
const comparison = (cutoffAtUtc: string | null) =>
  strictComparison({
    runs: 1,
    actual: 0.5,
    missingFromSheet: false,
    cutoffKnown: true,
    cutoffDate: "2026-09-08",
    cutoffAtUtc,
    runDate: "2026-09-09",
    logs,
  });

describe("date-only Central logs versus actual cutoff instants", () => {
  it("excludes the reproduced Eastern midnight case while leaving the legacy score intact", () => {
    const lateInstant = new Date("2026-09-08T04:30:00Z");
    expect(dateStrInTz(lateInstant)).toBe("2026-09-07");
    const cutoff = strictCutoffInstantForRun("2026-09-09", rule("America/New_York"));
    expect(cutoff).toBe("2026-09-08T04:15:00.000Z");
    expect(comparison(cutoff).reason).toBe("date_only_timing_unknown");
    expect(pickForecastAtCutoff(logs, "2026-09-08", "2026-09-09")?.madeOn).toBe("2026-09-07");
  });
  it.each([
    ["America/Chicago", "2026-09-08T05:15:00.000Z"],
    ["America/Denver", "2026-09-08T06:15:00.000Z"],
    ["America/Los_Angeles", "2026-09-08T07:15:00.000Z"],
    ["America/Phoenix", "2026-09-08T07:15:00.000Z"],
  ])("proves the full Central day before a %s cutoff", (tz, expected) => {
    const cutoff = strictCutoffInstantForRun("2026-09-09", rule(tz));
    expect(cutoff).toBe(expected);
    expect(comparison(cutoff).reason).toBeNull();
  });
  it("handles the exact day-end boundary and cutoff seconds", () => {
    expect(new Date(latestPossibleForecastInstant("2026-09-07")!).toISOString()).toBe(
      "2026-09-08T04:59:59.999Z",
    );
    expect(
      comparison(strictCutoffInstantForRun("2026-09-09", rule("America/New_York", "00:59:59")))
        .reason,
    ).toBe("date_only_timing_unknown");
    expect(
      comparison(strictCutoffInstantForRun("2026-09-09", rule("America/New_York", "01:00:00")))
        .reason,
    ).toBeNull();
  });
  it("accounts for winter offsets", () => {
    const cutoff = strictCutoffInstantForRun("2026-01-14", rule("America/New_York"));
    expect(cutoff).toBe("2026-01-13T05:15:00.000Z");
    expect(latestPossibleForecastInstant("2026-01-12")!).toBeGreaterThan(Date.parse(cutoff!));
  });
  it("uses 23-hour and 25-hour Central source days across DST transitions", () => {
    expect(
      latestPossibleForecastInstant("2026-03-08")! - latestPossibleForecastInstant("2026-03-07")!,
    ).toBe(23 * 3_600_000);
    expect(
      latestPossibleForecastInstant("2026-11-01")! - latestPossibleForecastInstant("2026-10-31")!,
    ).toBe(25 * 3_600_000);
  });
  it("rejects nonexistent cutoff wall times in the spring DST gap", () => {
    expect(
      strictCutoffInstantForRun("2026-03-09", [
        { cutoff_dow: 0, cutoff_time: "02:30", tz: "America/New_York", run_dows: [1] },
      ]),
    ).toBeNull();
  });
  it("uses the earlier cutoff instant for a repeated fall wall time", () => {
    expect(
      strictCutoffInstantForRun("2026-11-02", [
        { cutoff_dow: 0, cutoff_time: "01:30", tz: "America/New_York", run_dows: [1] },
      ]),
    ).toBe("2026-11-01T05:30:00.000Z");
  });
  it("uses the earlier bound for overlapping feeder rules", () => {
    const cutoff = strictCutoffInstantForRun("2026-09-09", [
      ...rule("America/Chicago"),
      ...rule("America/New_York"),
    ]);
    expect(cutoff).toBe("2026-09-08T04:15:00.000Z");
    expect(comparison(cutoff).picked).toBeNull();
  });
  it("can prove a same-calendar-day log for a late Pacific cutoff", () => {
    const cutoff = strictCutoffInstantForRun("2026-09-09", rule("America/Los_Angeles", "23:00"));
    expect(
      strictComparison({
        runs: 1,
        actual: 0.5,
        missingFromSheet: false,
        cutoffKnown: true,
        cutoffDate: "2026-09-08",
        cutoffAtUtc: cutoff,
        runDate: "2026-09-09",
        logs: [{ ...logs[0]!, made_on: "2026-09-08" }],
      }).picked?.madeOn,
    ).toBe("2026-09-08");
  });
  it("excludes missing time/zone, invalid dates and unsupported zones without guessing", () => {
    expect(strictCutoffInstantForRun("2026-09-09", [{ cutoff_dow: 2, run_dows: [3] }])).toBeNull();
    expect(strictCutoffInstantForRun("2026-09-09", rule("Unknown/Zone"))).toBeNull();
    expect(latestPossibleForecastInstant("2026-02-30")).toBeNull();
    expect(comparison(null).reason).toBe("cutoff_timing_unknown");
  });
});
