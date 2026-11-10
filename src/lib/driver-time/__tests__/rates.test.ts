import { describe, expect, it } from "vitest";
import {
  estimateCostWithRates, flaggedMinutesByDay, isValidHourlyRate, parseHourlyRate, rateHistory, rateOn, type PayRateRow,
} from "../rates";
import { estimateCost } from "../cost";
import { buildReconciledDrivers } from "../reconciliation";

// Synthetic driver and rates only.
const rates: PayRateRow[] = [
  { id: "r1", driver_id: "d1", hourly_rate: 20, effective_date: "2026-09-01" },
  { id: "r2", driver_id: "d1", hourly_rate: "22.50", effective_date: "2026-10-07" },
  { id: "r3", driver_id: "d1", hourly_rate: 30, effective_date: "2026-12-01" }, // future-dated raise
  { id: "x1", driver_id: "d2", hourly_rate: 99, effective_date: "2026-01-01" },
];

describe("rateOn: latest effective_date <= day", () => {
  it("before the first rate -> no rate", () => {
    expect(rateOn(rates, "d1", "2026-08-31")).toBeNull();
  });
  it("on the effective date -> that rate applies", () => {
    expect(rateOn(rates, "d1", "2026-09-01")?.id).toBe("r1");
    expect(rateOn(rates, "d1", "2026-10-07")?.id).toBe("r2");
  });
  it("between two rates -> the earlier one", () => {
    expect(rateOn(rates, "d1", "2026-10-06")?.id).toBe("r1");
    expect(rateOn(rates, "d1", "2026-11-15")?.id).toBe("r2");
  });
  it("future-dated rate is ignored for past days", () => {
    expect(rateOn(rates, "d1", "2026-11-30")?.id).toBe("r2");
    expect(rateOn(rates, "d1", "2026-12-01")?.id).toBe("r3");
  });
  it("never uses another driver's rate", () => {
    expect(rateOn(rates, "d3", "2026-10-10")).toBeNull();
  });
  it("history is newest first", () => {
    expect(rateHistory(rates, "d1").map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
  });
});

describe("rate entry validation (USD, > 0, max 2 decimals)", () => {
  it("accepts 24.50, $26 and 0.01", () => {
    expect(parseHourlyRate("24.50")).toEqual({ ok: true, value: 24.5 });
    expect(parseHourlyRate("$26")).toEqual({ ok: true, value: 26 });
    expect(parseHourlyRate("0.01")).toEqual({ ok: true, value: 0.01 });
  });
  it("rejects 0, negatives, 3 decimals and text", () => {
    for (const s of ["0", "0.00", "-5", "24.505", "abc", ""]) expect(parseHourlyRate(s).ok).toBe(false);
  });
  it("server check matches", () => {
    expect(isValidHourlyRate(24.5)).toBe(true);
    expect(isValidHourlyRate(0)).toBe(false);
    expect(isValidHourlyRate(24.505)).toBe(false);
  });
  it("server check accepts every cent from $0.01 to $500.00 (no floating-point rejects)", () => {
    const rejected: number[] = [];
    for (let c = 1; c <= 50000; c++) {
      const value = Number((c / 100).toFixed(2));
      if (!isValidHourlyRate(value)) rejected.push(value);
    }
    expect(rejected).toEqual([]);
    for (const v of [18.15, 20.10, 16.10, 39.95]) expect(isValidHourlyRate(v)).toBe(true);
  });
  it("server check rejects 0, -1, 500.01, 24.505, 0.001, NaN and Infinity", () => {
    for (const v of [0, -1, 500.01, 24.505, 0.001, NaN, Infinity]) expect(isValidHourlyRate(v)).toBe(false);
  });
});

const base = { driverId: "d1", samsaraWeekHours: 0, weekStart: "2026-10-05", weekEnd: "2026-10-09", rates };

describe("estimateCostWithRates: each day priced at its own rate", () => {
  it("mid-week raise: Mon/Tue at old rate, Wed+ at new rate (no overtime)", () => {
    const byDay = { "2026-10-05": 60, "2026-10-06": 60, "2026-10-07": 120 };
    const e = estimateCostWithRates({ ...base, paycomHours: 38, flaggedHours: 4, byDay, unsplitMinutes: 0 });
    expect(e.cost).toBe(1 * 20 + 1 * 20 + 2 * 22.5); // 85
    expect(e.multiplier).toBe(1);
    expect(e.dailyRates.map((d) => d.hourlyRate)).toEqual([20, 20, 22.5]);
    expect(e.note).toContain("rate changed during this week");
  });
  it("overtime multiplier is unchanged (estimateCost's 1.5x at >= 40 Paycom hours)", () => {
    const byDay = { "2026-10-06": 60, "2026-10-07": 60 };
    const e = estimateCostWithRates({ ...base, paycomHours: 42, flaggedHours: 2, byDay, unsplitMinutes: 0 });
    expect(e.multiplier).toBe(1.5);
    expect(e.cost).toBe(20 * 1.5 + 22.5 * 1.5);
  });
  it("one rate all week equals the old single-rate estimate", () => {
    const byDay = { "2026-10-12": 90, "2026-10-13": 30 };
    const e = estimateCostWithRates({ ...base, weekStart: "2026-10-12", weekEnd: "2026-10-16", paycomHours: 40, flaggedHours: 2, byDay, unsplitMinutes: 0 });
    const old = estimateCost({ driverId: "d1", samsaraWeekHours: 0, paycomHours: 40, flaggedHours: 2, hourlyRate: 22.5 });
    expect(e.cost).toBe(old.cost);
    expect(e.multiplier).toBe(old.multiplier);
    expect(e.note).toBe(old.note);
  });
  it("no rate on any day -> existing 'no rate on file' note, cost null", () => {
    const byDay = { "2026-08-24": 60 };
    const e = estimateCostWithRates({ ...base, weekStart: "2026-08-24", weekEnd: "2026-08-28", paycomHours: 38, flaggedHours: 1, byDay, unsplitMinutes: 0 });
    expect(e.cost).toBeNull();
    expect(e.hourlyRate).toBeNull();
    expect(e.note).toBe("no rate on file");
  });
  it("first rate starts mid-week -> earlier days named as not costed", () => {
    const byDay = { "2026-08-31": 60, "2026-09-01": 60 };
    const e = estimateCostWithRates({ ...base, weekStart: "2026-08-31", weekEnd: "2026-09-04", paycomHours: 38, flaggedHours: 2, byDay, unsplitMinutes: 0 });
    expect(e.cost).toBe(20);
    expect(e.pricedMinutes).toBe(60);
    expect(e.excludedMinutes).toBe(60);
    expect(e.note).toBe("no rate on file for 2026-08-31 (1 h not costed)");
  });
  it("future-dated raise does not touch a past week", () => {
    const byDay = { "2026-11-23": 120 };
    const e = estimateCostWithRates({ ...base, weekStart: "2026-11-23", weekEnd: "2026-11-27", paycomHours: 38, flaggedHours: 2, byDay, unsplitMinutes: 0 });
    expect(e.cost).toBe(45);
  });
  it("official total without daily breakdown + mid-week change -> refuses to guess", () => {
    const e = estimateCostWithRates({ ...base, paycomHours: 38, flaggedHours: 2, byDay: {}, unsplitMinutes: 120 });
    expect(e.cost).toBeNull();
    expect(e.note).toMatch(/no daily breakdown/);
  });
  it("official total without breakdown + one rate all week -> priced", () => {
    const e = estimateCostWithRates({ ...base, weekStart: "2026-10-12", weekEnd: "2026-10-16", paycomHours: 38, flaggedHours: 2, byDay: {}, unsplitMinutes: 120 });
    expect(e.cost).toBe(45);
  });
});

describe("flaggedMinutesByDay mirrors the reported total", () => {
  const ev = (id: string, date: string, min: number, extra: Record<string, unknown> = {}) => ({
    id, driver_id: "d1", driver_name: "Synthetic Driver", event_date: date, duration_min: min, hub: "Dallas",
    location_source: "log", status: "new", needs_review: false, start_ts: `${date}T14:00:00Z`, end_ts: `${date}T15:00:00Z`, ...extra,
  });
  it("automated: counts only countable events, per day", () => {
    const events = [ev("a", "2026-10-05", 60), ev("b", "2026-10-07", 45), ev("c", "2026-10-07", 30, { status: "excused" }),
      ev("d", "2026-10-08", 20, { location_source: "unknown" }), ev("e", "2026-10-10", 50)];
    const [b] = buildReconciledDrivers(events, [], true);
    const split = flaggedMinutesByDay(b);
    expect(split.byDay).toEqual({ "2026-10-05": 60, "2026-10-07": 45, "2026-10-10": 50 });
    expect(Object.values(split.byDay).reduce((s, m) => s + m, 0)).toBe(b.flaggedMinutes);
  });
});
