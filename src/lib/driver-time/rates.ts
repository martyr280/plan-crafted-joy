// Driver hourly rates with effective dates (Joe Green, 2026-10-05).
//
// Client-safe and pure. Hours come from Paycom/Samsara exactly as before; this
// module only decides WHICH hourly rate applies to each day. The overtime
// multiplier and the "no rate on file" behaviour stay in estimateCost.

import { estimateCost, round2, type CostEstimate } from "@/lib/driver-time/cost";
import { weekday } from "@/lib/driver-time/reconciliation";

export type PayRateRow = {
  id?: string;
  driver_id: string;
  driver_name?: string | null;
  hourly_rate: number | string;
  effective_date: string; // YYYY-MM-DD
  updated_at?: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rate in force on `day`: the row for this driver with the latest
 * effective_date <= day. Rates dated after `day` are ignored, so a future raise
 * never changes past weeks. Returns null before the driver's first rate.
 */
export function rateOn(rates: readonly PayRateRow[], driverId: string, day: string): PayRateRow | null {
  let best: PayRateRow | null = null;
  for (const r of rates) {
    if (String(r.driver_id) !== String(driverId)) continue;
    if (!DATE_RE.test(r.effective_date) || r.effective_date > day) continue;
    if (!best || r.effective_date > best.effective_date) best = r;
  }
  return best;
}

/** Newest first; ties broken by id so the order is stable. */
export function rateHistory(rates: readonly PayRateRow[], driverId: string): PayRateRow[] {
  return rates
    .filter((r) => String(r.driver_id) === String(driverId))
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
}

/** Text a person typed → a rate, or an error. USD, > 0, at most 2 decimals. */
export const MAX_HOURLY_RATE = 500;
export function parseHourlyRate(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const s = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: "Enter a dollar amount with at most 2 decimals, for example 24.50." };
  const value = Number(s);
  if (!(value > 0)) return { ok: false, error: "The hourly rate must be more than $0." };
  if (value > MAX_HOURLY_RATE) return { ok: false, error: `The hourly rate must be more than $0, up to $${MAX_HOURLY_RATE}.` };
  return { ok: true, value };
}

/** Same rule for the server validator (numbers arrive already parsed). */
export function isValidHourlyRate(n: number): boolean {
  if (!Number.isFinite(n) || !(n > 0) || n > MAX_HOURLY_RATE) return false;
  const cents = n * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

export function isValidDateStr(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Split a reconciled driver's reported minutes by calendar day, mirroring the
 * counting rules in buildReconciledDrivers (it is not changed):
 *  - official weekday total wins over automated weekday events; its intervals
 *    give the days. An official total without intervals cannot be split.
 *  - weekend events always count when present (they are only in the bucket
 *    when weekends are included).
 *  - excused, superseded and unresolved-location events never count.
 */
export function flaggedMinutesByDay(b: any): { byDay: Record<string, number>; unsplitMinutes: number } {
  const byDay: Record<string, number> = {};
  let unsplitMinutes = 0;
  const add = (d: string, m: number) => { if (m) byDay[d] = (byDay[d] ?? 0) + m; };
  const official = b?.official ?? null;
  if (official) {
    if (Array.isArray(official.intervals) && official.intervals.length) {
      for (const i of official.intervals) add(String(i.date), Number(i.minutes ?? 0));
    } else {
      unsplitMinutes += Number(b.officialMinutes ?? official.minutes ?? 0);
    }
  }
  for (const ev of b?.events ?? []) {
    const min = Number(ev.duration_min ?? 0);
    if (ev.superseded_at || ev.status === "excused") continue;
    if ((ev.needs_review && ev.status === "new") || ev.location_source === "unknown" || !ev.hub) continue;
    const isWeekday = weekday(ev.event_date);
    if (isWeekday && official) continue; // official weekday total already counted
    add(String(ev.event_date), min);
  }
  return { byDay, unsplitMinutes };
}

export type DailyRate = { date: string; minutes: number; hourlyRate: number | null; effectiveDate: string | null };
export type RatedCostEstimate = CostEstimate & { dailyRates: DailyRate[] };

export type RatedCostInput = {
  driverId: string;
  driverName?: string | null;
  samsaraWeekHours: number;
  paycomHours?: number | null;
  /** Whole-week reported hours (unchanged source of truth for hours). */
  flaggedHours: number;
  byDay: Record<string, number>;
  unsplitMinutes: number;
  weekStart: string;
  weekEnd: string;
  rates: readonly PayRateRow[];
};

/**
 * Cost with a per-day rate. Each day's minutes are priced at rateOn(day); the
 * overtime multiplier is the one estimateCost already derives from weekly
 * hours. With no applicable rate on any day the result is exactly what
 * estimateCost returns for "no rate on file".
 */
export function estimateCostWithRates(input: RatedCostInput): RatedCostEstimate {
  const base = { driverId: input.driverId, driverName: input.driverName, samsaraWeekHours: input.samsaraWeekHours,
    paycomHours: input.paycomHours, flaggedHours: input.flaggedHours };
  const num = (r: PayRateRow | null) => (r ? Number(r.hourly_rate) : null);
  const days = Object.keys(input.byDay).sort();
  const dailyRates: DailyRate[] = days.map((date) => {
    const r = rateOn(input.rates, input.driverId, date);
    const n = num(r);
    return { date, minutes: input.byDay[date], hourlyRate: n && n > 0 ? n : null, effectiveDate: n && n > 0 ? r!.effective_date : null };
  });

  // Official total without a daily breakdown: one rate only if the same rate
  // row covers the whole week; otherwise we refuse to guess.
  let unsplitRate: number | null = null;
  if (input.unsplitMinutes > 0) {
    const first = rateOn(input.rates, input.driverId, input.weekStart);
    const last = rateOn(input.rates, input.driverId, input.weekEnd);
    if (!last) {
      // falls through to "no rate" handling below
    } else if (!first || first !== last) {
      const e = estimateCost({ ...base, hourlyRate: num(last) });
      return { ...e, cost: null, note: "Rate changed during this week and the official total has no daily breakdown", dailyRates };
    } else {
      unsplitRate = num(last);
    }
  }

  const rated = dailyRates.filter((d) => d.hourlyRate !== null);
  if (!rated.length && unsplitRate === null) {
    // No per-day minutes at all: keep the old behaviour of showing the rate in
    // force at week end (cost 0). No rate anywhere: existing "no rate" note.
    const fallback = days.length || input.unsplitMinutes > 0 ? null : num(rateOn(input.rates, input.driverId, input.weekEnd));
    return { ...estimateCost({ ...base, hourlyRate: fallback }), dailyRates };
  }

  const latestRate = rated.length ? rated[rated.length - 1].hourlyRate! : unsplitRate!;
  const e = estimateCost({ ...base, hourlyRate: latestRate });
  const multiplier = e.multiplier ?? 1;
  let raw = 0;
  for (const d of rated) raw += (d.minutes / 60) * d.hourlyRate! * multiplier;
  if (unsplitRate !== null) raw += (input.unsplitMinutes / 60) * unsplitRate * multiplier;

  const unrated = dailyRates.filter((d) => d.hourlyRate === null);
  const distinct = new Set(rated.map((d) => d.hourlyRate));
  let note = e.note;
  if (unrated.length) {
    const mins = unrated.reduce((s, d) => s + d.minutes, 0);
    note = `no rate on file for ${unrated.map((d) => d.date).join(", ")} (${round2(mins / 60)} h not costed)`;
  } else if (distinct.size > 1) {
    note = [e.note, "rate changed during this week"].filter(Boolean).join("; ");
  }
  return { ...e, cost: round2(raw), note, dailyRates };
}

/** Today's date for rate defaults (Central time, same as the rest of Driver Time). */
export function isFutureRate(r: PayRateRow, today: string): boolean {
  return r.effective_date > today;
}

export function duplicatePayRateMessage(date: string): string {
  return `This driver already has a rate starting ${date}. Edit that row instead.`;
}

export const STALE_PAY_RATE_MESSAGE = "This rate changed since you opened it. Refresh and try again.";

/** Map a Postgres write failure to the message the rate dialog shows. */
export function payRateWriteError(e: { code?: string; message?: string } | null | undefined, date: string): Error {
  if (e?.code === "23505") return new Error(duplicatePayRateMessage(date));
  return new Error(e?.message || "Could not save the rate");
}

/**
 * Price a week only when the caller may see pay. When canPay is false the
 * supplied rate rows are ignored, so a weekly report cannot leak an amount.
 */
export function priceDriverWeek(canPay: boolean, input: RatedCostInput): RatedCostEstimate {
  if (!canPay) {
    const hidden = estimateCost({
      driverId: input.driverId,
      driverName: input.driverName,
      samsaraWeekHours: input.samsaraWeekHours,
      paycomHours: input.paycomHours,
      flaggedHours: input.flaggedHours,
      hourlyRate: null,
    });
    return { ...hidden, dailyRates: [] };
  }
  return estimateCostWithRates(input);
}
