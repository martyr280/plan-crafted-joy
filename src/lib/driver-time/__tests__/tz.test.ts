import { describe, expect, it } from "vitest";
import { CENTRAL_TZ, dateStrInTz, tzOffsetMinutesAt } from "../tz";

describe("tzOffsetMinutesAt", () => {
  it("returns CDT (-300) for August in Chicago", () => {
    expect(tzOffsetMinutesAt(new Date("2026-08-17T12:00:00Z"))).toBe(-300);
  });

  it("returns CST (-360) for January in Chicago", () => {
    expect(tzOffsetMinutesAt(new Date("2026-01-15T12:00:00Z"))).toBe(-360);
  });

  it("is DST-aware for other zones", () => {
    expect(tzOffsetMinutesAt(new Date("2026-08-17T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(tzOffsetMinutesAt(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(tzOffsetMinutesAt(new Date("2026-08-17T12:00:00Z"), "UTC")).toBe(0);
  });
});

describe("dateStrInTz", () => {
  it("uses the previous evening's date for ~01:00Z", () => {
    expect(dateStrInTz(new Date("2026-08-17T01:00:00Z"))).toBe("2026-08-16");
  });

  it("matches UTC date later in the day", () => {
    expect(dateStrInTz(new Date("2026-08-17T18:00:00Z"), CENTRAL_TZ)).toBe("2026-08-17");
  });
});
