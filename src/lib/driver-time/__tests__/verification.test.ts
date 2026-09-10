import { describe, expect, it } from "vitest";
import { buildReconciledDrivers, overlapMinutes } from "../reconciliation";

const OFFICIAL = {
  driverName: "Joseph Outler",
  hub: "Ocala" as const,
  minutes: 600,
  scope: "weekdays" as const,
  source: "Official weekly report",
  reason: "Loaded from Joe's audited spreadsheet",
  intervals: [
    { date: "2026-08-19", start: "2026-08-19T12:03:00.000Z", end: "2026-08-19T20:49:00.000Z", minutes: 526 },
    { date: "2026-08-20", start: "2026-08-20T12:00:00.000Z", end: "2026-08-20T13:14:00.000Z", minutes: 74 },
  ],
};

function ev(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    driver_id: "53243882",
    driver_name: "Joseph Outler",
    event_date: "2026-08-19",
    start_ts: "2026-08-19T12:03:00.000Z",
    end_ts: "2026-08-19T20:49:00.000Z",
    duration_min: 526,
    hub: "Ocala",
    location_source: "assumed_hub",
    needs_review: false,
    status: "new",
    superseded_at: null,
    statuses: ["onDuty"],
    ...over,
  };
}

describe("overlapMinutes", () => {
  it("returns zero for disjoint intervals and the overlap otherwise", () => {
    expect(overlapMinutes(0, 60_000, 60_000, 120_000)).toBe(0);
    expect(overlapMinutes(0, 120_000, 60_000, 180_000)).toBe(1);
  });
});

describe("assumed_hub events are resolved evidence", () => {
  it("counts toward automated minutes, not unresolved minutes", () => {
    const [d] = buildReconciledDrivers([ev()], [
      { driver_id: "53243882", warehouse_actual: OFFICIAL, updated_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(d.automatedMinutes).toBe(526);
    expect(d.unresolvedMinutes).toBe(0);
  });
});

describe("official-interval verification", () => {
  it("marks the interval Nelson saw as verified and the other as unverified", () => {
    const [d] = buildReconciledDrivers([ev()], [
      { driver_id: "53243882", warehouse_actual: OFFICIAL, updated_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(d.official.intervals.map((i: any) => i.verified)).toEqual([true, false]);
    expect(d.unverifiedOfficialMinutes).toBe(74);
  });

  it("ignores superseded and excused evidence", () => {
    const [d] = buildReconciledDrivers([ev({ superseded_at: "2026-09-02T00:00:00Z" })], [
      { driver_id: "53243882", warehouse_actual: OFFICIAL, updated_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(d.official.intervals.every((i: any) => i.verified === false)).toBe(true);
    expect(d.unverifiedOfficialMinutes).toBe(600);
  });

  it("flags automated events with no official counterpart as nelsonOnly", () => {
    const [d] = buildReconciledDrivers(
      [
        ev(),
        ev({ id: "e2", event_date: "2026-08-21", start_ts: "2026-08-21T14:00:00.000Z", end_ts: "2026-08-21T18:00:00.000Z", duration_min: 240 }),
      ],
      [{ driver_id: "53243882", warehouse_actual: OFFICIAL, updated_at: "2026-09-01T00:00:00Z" }],
    );
    const byId = new Map<string, any>(d.events.map((e: any) => [e.id, e]));
    expect(byId.get("e1").nelsonOnly).toBe(false);
    expect(byId.get("e2").nelsonOnly).toBe(true);
  });

  it("leaves drivers without an official record unannotated", () => {
    const [d] = buildReconciledDrivers([ev({ driver_id: "999" })], []);
    expect(d.events[0].nelsonOnly).toBeUndefined();
    expect(d.unverifiedOfficialMinutes).toBeNull();
  });
});
