import { describe, expect, it } from "vitest";
import { describeCursor } from "../sweep-progress";
import { hasActiveSweep } from "@/hooks/useDriverTime";

describe("14. Sweeps tab progress", () => {
  it("refreshes only while a run is queued or running", () => {
    expect(hasActiveSweep([{ status: "completed" }, { status: "failed" }])).toBe(false);
    expect(hasActiveSweep([{ status: "completed" }, { status: "queued" }])).toBe(true);
    expect(hasActiveSweep([{ status: "running" }])).toBe(true);
    expect(hasActiveSweep(undefined)).toBe(false);
  });
  it("shows the phase position", () => {
    const c = { days: new Array(9), roster: new Array(40), vehicleIds: new Array(17), gpsDayIdx: 1, gpsChunkIdx: 0, detectIdx: 11 };
    expect(describeCursor("fetch_gps", c)).toBe("GPS day 2 of 9, chunk 1 of 6");
    expect(describeCursor("detect", c)).toBe("driver 12 of 40");
    expect(describeCursor(null, null)).toBe("not started");
  });
});
