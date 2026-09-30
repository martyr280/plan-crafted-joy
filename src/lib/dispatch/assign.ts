// Pure run assignment for Dispatch: (ticket date, route cutoffs) -> run date.
//
// Rule (date basis confirmed by Joe Green 2026-09-29: pick_ticket_print):
//  * From the chosen date, the ticket goes on the first cutoff (cutoff_dow +
//    cutoff_time, in the cutoff's tz) that is on or after that date, for the
//    route_cutoffs rows whose p21_code = route_code.
//  * Date-only inputs are treated as BEFORE the cutoff time on that day, so a
//    ticket dated on a cutoff day makes that day's cutoff.
//  * Run date = the first run_dows day AFTER that cutoff date (the morning the
//    truck departs). Several matching cutoff rows -> earliest run wins.
//  * Run date before today (America/Chicago) -> "stale", never a current run.
//  * Run exceptions (2026-09-29, Joe: "short weeks or driver capacity (PTO)"):
//    a 'no_run' on the picked run date rolls the ticket to the route's next
//    run_dows day (union of all active cutoff rows) that is not also no_run,
//    searching up to 60 days. 'reduced' never moves tickets (flag only).
//    Stale is judged on the final run date.
// No I/O.

import { addDaysISO, dowOfISO } from "@/lib/truck-capacity/cutoffs";

export type DateBasis = "pick_ticket_print" | "earliest_required" | "requested" | "promise";
export const DATE_BASES: DateBasis[] = ["pick_ticket_print", "earliest_required", "requested", "promise"];
export const DATE_BASIS_LABEL: Record<DateBasis, string> = {
  pick_ticket_print: "Pick ticket print date",
  earliest_required: "Earliest required date",
  requested: "Requested date",
  promise: "Promise date",
};
export const DATE_BASIS_COLUMN: Record<DateBasis, string> = {
  pick_ticket_print: "pick_ticket_print_date",
  earliest_required: "earliest_required_date",
  requested: "requested_date",
  promise: "promise_date",
};

export type AssignCutoff = {
  p21_code: string | null;
  cutoff_dow: number;
  cutoff_time: string;
  run_dows: number[];
  active?: boolean;
};

export type ExceptionReason = "short_week" | "driver_pto" | "other";
export type NoRunException = { run_date: string; reason: ExceptionReason };
export type RolledFrom = { runDate: string; reason: ExceptionReason };

export type Assignment =
  | { status: "assigned"; runDate: string; cutoffDate: string; rolledFrom?: RolledFrom }
  | { status: "stale"; runDate: string; cutoffDate: string; rolledFrom?: RolledFrom }
  | { status: "no_date" }
  | { status: "no_cutoff" };

/** "2026-09-28", "2026-09-28T13:05:00", "2026-09-28 13:05:00.000" -> date + optional HH:MM. */
export function splitDateTime(v: unknown): { date: string; time: string | null } | null {
  if (v === null || v === undefined || v === "") return null;
  const s = v instanceof Date ? v.toISOString() : String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  const time = m[2] && !(m[2] === "00" && m[3] === "00") ? `${m[2]}:${m[3]}` : null;
  return { date: m[1], time };
}

export const ROLL_SEARCH_DAYS = 60;

export function assignRun(dateValue: unknown, cutoffs: AssignCutoff[], todayISO: string, noRuns?: NoRunException[]): Assignment {
  const active = cutoffs.filter((c) => c.active !== false && (c.run_dows ?? []).length > 0);
  if (!active.length) return { status: "no_cutoff" };
  const dt = splitDateTime(dateValue);
  if (!dt) return { status: "no_date" };

  let best: { runDate: string; cutoffDate: string } | null = null;
  for (const c of active) {
    const cutTime = String(c.cutoff_time ?? "").slice(0, 5);
    let cutoffDate: string | null = null;
    for (let i = 0; i <= 7; i++) {
      const d = addDaysISO(dt.date, i);
      if (dowOfISO(d) !== c.cutoff_dow) continue;
      // Same day with a real timestamp after the cutoff time misses it.
      if (i === 0 && dt.time && dt.time > cutTime) continue;
      cutoffDate = d;
      break;
    }
    if (!cutoffDate) continue;
    let runDate: string | null = null;
    for (let i = 1; i <= 7; i++) {
      const d = addDaysISO(cutoffDate, i);
      if (c.run_dows.includes(dowOfISO(d))) { runDate = d; break; }
    }
    if (!runDate) continue;
    if (!best || runDate < best.runDate) best = { runDate, cutoffDate };
  }
  if (!best) return { status: "no_cutoff" };
  const blocked = new Map((noRuns ?? []).map((e) => [String(e.run_date).slice(0, 10), e.reason]));
  const hit = blocked.get(best.runDate);
  if (hit) {
    const next = nextOpenRunDate(best.runDate, active, noRuns ?? []);
    if (!next) return { status: "no_cutoff" };
    const rolled = { runDate: next, cutoffDate: best.cutoffDate, rolledFrom: { runDate: best.runDate, reason: hit } };
    return next < todayISO ? { status: "stale", ...rolled } : { status: "assigned", ...rolled };
  }
  return best.runDate < todayISO ? { status: "stale", ...best } : { status: "assigned", ...best };
}

/**
 * The route's next run day strictly after `fromISO` (union of active cutoff
 * run_dows) that is not itself a no_run. Same roll rule assignRun uses.
 */
export function nextOpenRunDate(fromISO: string, cutoffs: AssignCutoff[], noRuns: NoRunException[]): string | null {
  const active = cutoffs.filter((c) => c.active !== false && (c.run_dows ?? []).length > 0);
  const dows = new Set(active.flatMap((c) => c.run_dows));
  const blocked = new Set(noRuns.map((e) => String(e.run_date).slice(0, 10)));
  for (let i = 1; i <= ROLL_SEARCH_DAYS; i++) {
    const d = addDaysISO(fromISO, i);
    if (dows.has(dowOfISO(d)) && !blocked.has(d)) return d;
  }
  return null;
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);
}
