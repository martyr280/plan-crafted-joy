// Pure roll-forward helpers for the Truck Capacity P21 demand snapshot.
//
// P21 gives us open routed demand keyed by required_date (with past-due
// backlog clamped onto today). But a truck only leaves on its route's run
// days, and only orders placed before the next cutoff make that run. So a
// demand row dated "today" does not ship today — it ships on the next run
// date fed by the next cutoff that has not yet passed.
//
// No I/O; all timezone logic reuses src/lib/truck-capacity/cutoffs.ts.

import {
  addDaysISO,
  dowOfISO,
  localDateIn,
  runDatesFor,
  zonedWallToUtc,
  type RouteCutoff,
} from "./cutoffs";

/**
 * Every ship date reachable by a route's still-upcoming cutoffs, within
 * `horizonDays` local days of `now`. Sorted ascending, de-duplicated.
 * Empty when the route has no active cutoffs (e.g. the *-SPECIAL routes).
 */
export function runDatesInWindow(
  cutoffs: RouteCutoff[],
  now: Date,
  horizonDays = 35,
): string[] {
  const out = new Set<string>();
  for (const c of cutoffs) {
    if (!c.active) continue;
    const time = String(c.cutoff_time ?? "").slice(0, 5);
    if (!time) continue;
    const today = localDateIn(c.tz, now);
    for (let i = 0; i <= horizonDays; i++) {
      const date = addDaysISO(today, i);
      if (dowOfISO(date) !== c.cutoff_dow) continue;
      const atUtc = zonedWallToUtc(date, time, c.tz);
      if (atUtc.getTime() <= now.getTime()) continue; // cutoff already passed
      for (const d of runDatesFor(c, date)) out.add(d);
    }
  }
  return Array.from(out).sort();
}

/**
 * Smallest run date on/after `shipDateISO`. Returns the input unchanged when
 * there are no run dates, or when every run date is earlier. Never moves a
 * date backwards.
 */
export function rollForward(shipDateISO: string, runDates: string[]): string {
  let best: string | null = null;
  for (const d of runDates) {
    if (d < shipDateISO) continue;
    if (best === null || d < best) best = d;
  }
  return best ?? shipDateISO;
}
