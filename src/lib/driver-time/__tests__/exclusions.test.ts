import { describe, expect, it } from "vitest";
import {
  effectiveHiddenFrom,
  hiddenFromFor,
  idExclusionFor,
  isExcludedDriverOn,
  normalizeExcludedDrivers,
} from "../exclusions";

// Synthetic ids. November 2026 is CST (UTC-6): DST ended Nov 1.
const dated = {
  excludedDriverIds: [],
  excludedDriverNamePatterns: [],
  excludedDrivers: [{ id: "800", hiddenFrom: "2026-11-09" }],
};

describe("hiddenFromFor (Central week start)", () => {
  it("uses the Central calendar date, not UTC", () => {
    // Sun Nov 8, 23:59:59 CST is already Monday in UTC.
    expect(hiddenFromFor(new Date("2026-11-09T05:59:59Z"))).toBe("2026-11-02");
    // Mon Nov 9, 00:00 CST.
    expect(hiddenFromFor(new Date("2026-11-09T06:00:00Z"))).toBe("2026-11-09");
    // Wed Nov 11 (today) and Sun Nov 15, 23:59 CST.
    expect(hiddenFromFor(new Date("2026-11-11T17:00:00Z"))).toBe("2026-11-09");
    expect(hiddenFromFor(new Date("2026-11-16T05:59:00Z"))).toBe("2026-11-09");
  });
});

describe("isExcludedDriverOn boundary days", () => {
  const d = { id: "800", name: "Dana Dated" };
  it("keeps the driver before hiddenFrom and excludes them from it on", () => {
    expect(isExcludedDriverOn(d, dated, "2026-11-06")).toBe(false); // Fri before
    expect(isExcludedDriverOn(d, dated, "2026-11-08")).toBe(false); // Sun before
    expect(isExcludedDriverOn(d, dated, "2026-11-09")).toBe(true); // Monday
    expect(isExcludedDriverOn(d, dated, "2026-11-10")).toBe(true);
    expect(isExcludedDriverOn(d, dated, "2027-01-04")).toBe(true);
  });

  it("rounds a non-Monday hiddenFrom down to its week's Monday", () => {
    const wed = { ...dated, excludedDrivers: [{ id: "800", hiddenFrom: "2026-11-11" }] };
    expect(effectiveHiddenFrom({ hiddenFrom: "2026-11-11" })).toBe("2026-11-09");
    expect(isExcludedDriverOn(d, wed, "2026-11-08")).toBe(false);
    expect(isExcludedDriverOn(d, wed, "2026-11-09")).toBe(true);
  });

  it("treats a dated entry with an unreadable hiddenFrom as hidden in every week", () => {
    const bad = normalizeExcludedDrivers([{ id: "800", hiddenFrom: "not-a-date" }]);
    expect(bad).toEqual([{ id: "800", hiddenFrom: "", hiddenBy: null, hiddenAt: null }]);
    expect(isExcludedDriverOn(d, { excludedDrivers: bad }, "2000-01-03")).toBe(true);
  });
});

describe("legacy and dated together", () => {
  const both = {
    excludedDriverIds: ["58143755"],
    excludedDriverNamePatterns: ["Test Hub LTL"],
    excludedDrivers: [
      { id: "55836799", hiddenFrom: "2026-11-09" },
      { id: "53332924", hiddenFrom: "2026-11-09" },
    ],
  };
  it("legacy ids stay hidden in every week; dated ids only from hiddenFrom", () => {
    for (const day of ["2025-01-06", "2026-11-06", "2026-11-09"]) {
      expect(isExcludedDriverOn({ id: "58143755" }, both, day)).toBe(true);
    }
    expect(isExcludedDriverOn({ id: "55836799" }, both, "2026-11-06")).toBe(false);
    expect(isExcludedDriverOn({ id: "55836799" }, both, "2026-11-09")).toBe(true);
    expect(isExcludedDriverOn({ id: "53332924" }, both, "2026-11-08")).toBe(false);
    expect(isExcludedDriverOn({ id: "53332924" }, both, "2026-11-12")).toBe(true);
  });

  it("legacy wins when an id is in both lists", () => {
    const dup = { ...both, excludedDrivers: [{ id: "58143755", hiddenFrom: "2026-11-09" }] };
    expect(idExclusionFor("58143755", dup)).toEqual({ kind: "legacy" });
    expect(isExcludedDriverOn({ id: "58143755" }, dup, "2026-11-02")).toBe(true);
  });

  it("the earliest dated entry wins when an id is listed twice", () => {
    const twice = {
      excludedDrivers: [
        { id: "9", hiddenFrom: "2026-11-16" },
        { id: "9", hiddenFrom: "2026-11-02" },
      ],
    };
    expect(idExclusionFor("9", twice)).toEqual({ kind: "dated", from: "2026-11-02" });
  });

  it("name patterns exclude on every date regardless of id", () => {
    expect(isExcludedDriverOn({ id: "x", name: "test hub ltl 2" }, both, "2020-01-06")).toBe(true);
    expect(isExcludedDriverOn({ id: "x", name: "Someone" }, both, "2026-11-09")).toBe(false);
  });
});

describe("normalizeExcludedDrivers", () => {
  it("drops non-objects and entries without an id, stringifies ids", () => {
    expect(
      normalizeExcludedDrivers([
        null,
        "x",
        { hiddenFrom: "2026-11-09" },
        { id: 7, hiddenFrom: "2026-11-09", hiddenBy: "u", hiddenAt: "t" },
      ]),
    ).toEqual([{ id: "7", hiddenFrom: "2026-11-09", hiddenBy: "u", hiddenAt: "t" }]);
    expect(normalizeExcludedDrivers(undefined)).toEqual([]);
    expect(normalizeExcludedDrivers({})).toEqual([]);
  });
});
