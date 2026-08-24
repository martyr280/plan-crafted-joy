// Pure watermark logic for the dispatch builder cron block.
//
// The cron route fires on every invocation. We must build each cutoff exactly
// once: never twice (two Samsara routes / two proposals for one truck) and
// never zero times (Joe's board silently empty on a delivery morning).
//
// The contract:
//   window = (watermarkMs, nowMs]  — lower bound EXCLUSIVE, upper INCLUSIVE
// so a cutoff that fires exactly at a tick boundary is counted by that tick and
// by no other. The caller persists `nowMs` as the new watermark afterwards.
//
// Builds are also delayed by `buildDelayMin` past the cutoff instant: P21 needs
// a few minutes to finish allocating after the cutoff. A cutoff inside the
// window but younger than the delay is reported `dueAtMs` in the future and
// must NOT advance the watermark past it — see `nextWatermark`.

import {
  addDaysISO,
  dowOfISO,
  localDateIn,
  runDatesFor,
  zonedWallToUtc,
  type RouteCutoff,
} from "@/lib/truck-capacity/cutoffs";

export type FiredCutoff = {
  cutoff: RouteCutoff;
  /** UTC ms the cutoff fired. */
  atMs: number;
  /** Local (tz) calendar date of the cutoff. */
  localDate: string;
  /** UTC ms the build becomes due (atMs + buildDelayMin). */
  dueAtMs: number;
  /** Ship dates this cutoff feeds. */
  runDates: string[];
};

/** Every occurrence of one cutoff with atMs in (fromMs, toMs]. */
export function occurrencesBetween(cutoff: RouteCutoff, fromMs: number, toMs: number): Array<{ atMs: number; localDate: string }> {
  if (!cutoff.active) return [];
  if (!(toMs > fromMs)) return [];
  const tz = cutoff.tz || "America/Chicago";
  const time = String(cutoff.cutoff_time ?? "00:00").slice(0, 5);
  // Scan local days spanning the window with a day of slack on each side so a
  // zone offset can never clip an occurrence.
  const startDate = addDaysISO(localDateIn(tz, new Date(fromMs)), -1);
  const days = Math.ceil((toMs - fromMs) / 86_400_000) + 3;
  const out: Array<{ atMs: number; localDate: string }> = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysISO(startDate, i);
    if (dowOfISO(date) !== cutoff.cutoff_dow) continue;
    const atMs = zonedWallToUtc(date, time, tz).getTime();
    if (atMs > fromMs && atMs <= toMs) out.push({ atMs, localDate: date });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Cutoffs that fired in (watermarkMs, nowMs], oldest first.
 * `buildDelayMin` only annotates `dueAtMs`; filtering on it is the caller's job
 * (via `dueCutoffs`) so an undue cutoff can be left for the next tick.
 */
export function cutoffsFiredSince(
  cutoffs: RouteCutoff[],
  watermarkMs: number,
  nowMs: number,
  buildDelayMin = 10,
): FiredCutoff[] {
  const out: FiredCutoff[] = [];
  for (const c of cutoffs) {
    for (const occ of occurrencesBetween(c, watermarkMs, nowMs)) {
      out.push({
        cutoff: c,
        atMs: occ.atMs,
        localDate: occ.localDate,
        dueAtMs: occ.atMs + Math.max(0, buildDelayMin) * 60_000,
        runDates: runDatesFor(c, occ.localDate),
      });
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The subset whose build delay has elapsed. */
export function dueCutoffs(fired: FiredCutoff[], nowMs: number): FiredCutoff[] {
  return fired.filter((f) => f.dueAtMs <= nowMs);
}

/**
 * New watermark after processing this tick.
 *
 * `now` normally, but held back to just before the oldest NOT-yet-due cutoff so
 * that cutoff is re-reported next tick instead of being lost to the delay.
 */
export function nextWatermark(fired: FiredCutoff[], nowMs: number): number {
  const pending = fired.filter((f) => f.dueAtMs > nowMs).map((f) => f.atMs);
  if (!pending.length) return nowMs;
  return Math.min(...pending) - 1;
}
