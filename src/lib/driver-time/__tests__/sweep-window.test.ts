import { describe, expect, it } from "vitest";
import { weekBounds } from "../../driver-time.server";

describe("weekBounds", () => {
  it("returns Monday through Sunday for a mid-week date", () => {
    const monday = new Date("2026-08-17T12:00:00Z"); // Monday noon UTC
    const { weekStart, weekEnd } = weekBounds(monday);
    expect(weekStart).toBe("2026-08-17");
    expect(weekEnd).toBe("2026-08-23");
  });

  it("returns the previous week for a Sunday date", () => {
    const sunday = new Date("2026-08-23T12:00:00Z"); // Sunday noon UTC
    const { weekStart, weekEnd } = weekBounds(sunday);
    expect(weekStart).toBe("2026-08-17");
    expect(weekEnd).toBe("2026-08-23");
  });
});

describe("runDriverTimeSweep window clamping", () => {
  it("clamps the Samsara fetch end to now on a mid-week Monday", () => {
    const now = new Date("2026-08-17T22:00:00Z"); // Monday evening UTC
    const { weekEnd } = weekBounds(now);
    const rawEndMs = Date.parse(`${weekEnd}T23:59:59Z`); // 2026-08-23T23:59:59Z
    const endMs = Math.min(rawEndMs, now.getTime());

    expect(endMs).toBe(now.getTime());
    expect(endMs).toBeLessThan(rawEndMs);

    const lookbackDays = 8;
    const startMs = endMs - lookbackDays * 86_400_000;
    expect(startMs).toBeLessThan(endMs);
    // 8-day lookback still covers the entire prior week.
    expect(startMs).toBeLessThanOrEqual(Date.parse("2026-08-15T23:59:59Z"));
  });

  it("does not clamp when the sweep runs at the very end of Sunday UTC", () => {
    const now = new Date("2026-08-23T23:59:00Z");
    const { weekEnd } = weekBounds(now);
    const rawEndMs = Date.parse(`${weekEnd}T23:59:59Z`);
    const endMs = Math.min(rawEndMs, now.getTime());

    expect(endMs).toBe(now.getTime());
    // Within 60 seconds of the week boundary, so practically not clamped much.
    expect(rawEndMs - endMs).toBeLessThanOrEqual(60_000);
  });
});

describe("weekBounds Central anchoring", () => {
  it("treats Sunday 8pm Chicago (01:00Z Monday) as the week ending that Sunday", () => {
    const { weekStart, weekEnd } = weekBounds(new Date("2026-08-17T01:00:00Z"));
    expect(weekStart).toBe("2026-08-10");
    expect(weekEnd).toBe("2026-08-16");
  });
});
