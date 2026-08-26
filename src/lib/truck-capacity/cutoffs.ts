// Pure cutoff engine for the Truck Capacity forecast board.
//
// A route can have MANY weekly cutoffs (MTN01 has Tue 4pm AND Thu 5pm; Dallas
// locals cut off every weekday at 3pm). Given a route's cutoff rows and "now",
// this module answers:
//   - which cutoff is next, as a real UTC instant in the route's timezone
//   - which ship dates that cutoff's orders land on (the "order window")
//   - a human label so a wrong mapping is visible on the board, not silent
//
// No I/O, no dates-from-the-environment beyond the `now` you pass in, so the
// mapping logic can be corrected iteratively under test.

export type RouteCutoff = {
  id: string;
  route_id: string;
  p21_code: string | null;
  cutoff_dow: number;        // 0=Sun .. 6=Sat, in `tz`
  cutoff_time: string;       // "HH:MM" or "HH:MM:SS", wall clock in `tz`
  tz: string;                // IANA zone, e.g. "America/Chicago"
  run_dows: number[];        // days the orders actually ship (0=Sun..6=Sat)
  run_days_label: string | null;
  driver_name: string | null;
  notes: string | null;
  sort_order: number;
  active: boolean;
};

export type NextCutoff = {
  cutoff: RouteCutoff;
  /** UTC instant of the next occurrence of this cutoff. */
  atUtc: Date;
  /** Local (tz) calendar date of the cutoff, ISO yyyy-mm-dd. */
  localDate: string;
  /** "Tue 4:00p" */
  timeLabel: string;
  /** Whole days between today (tz) and the cutoff date (tz). 0 = today. */
  daysAway: number;
  isToday: boolean;
  isTomorrow: boolean;
  /** Ship dates fed by this cutoff, ISO, ascending. */
  runDates: string[];
  /** Order-window bounds over runDates (equal to first/last runDate). */
  windowFrom: string | null;
  windowTo: string | null;
  /** "Orders counted through Tue 4:00p (Wed–Thu run)" */
  label: string;
};

export const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MS_DAY = 86_400_000;

/* ------------------------------ tz primitives ------------------------------ */

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

type Wall = { y: number; m: number; d: number; h: number; mi: number; s: number };

function wallPartsIn(tz: string, instant: Date): Wall {
  const parts = partsFmt(tz).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Intl renders midnight as hour 24 in some engines.
  const h = get("hour") % 24;
  return { y: get("year"), m: get("month"), d: get("day"), h, mi: get("minute"), s: get("second") };
}

/** Offset (minutes) that `tz` is ahead of UTC at the given instant. */
export function tzOffsetMinutes(tz: string, instant: Date): number {
  const w = wallPartsIn(tz, instant);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Convert a wall-clock date+time in `tz` to the corresponding UTC instant. */
export function zonedWallToUtc(dateISO: string, timeHHMM: string, tz: string): Date {
  const [y, m, d] = dateISO.split("-").map(Number);
  const [hh, mm] = timeHHMM.split(":").map(Number);
  const guess = Date.UTC(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0);
  // Two passes converge across DST transitions.
  let utc = guess - tzOffsetMinutes(tz, new Date(guess)) * 60_000;
  utc = guess - tzOffsetMinutes(tz, new Date(utc)) * 60_000;
  return new Date(utc);
}

/** Calendar date (ISO) in `tz` for an instant. */
export function localDateIn(tz: string, instant: Date): string {
  const w = wallPartsIn(tz, instant);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Day of week (0=Sun) of an ISO date, timezone-independent. */
export function dowOfISO(dateISO: string): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const t = Date.UTC(y!, (m ?? 1) - 1, d ?? 1) + days * MS_DAY;
  return new Date(t).toISOString().slice(0, 10);
}

function diffDaysISO(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, (bm ?? 1) - 1, bd ?? 1) - Date.UTC(ay!, (am ?? 1) - 1, ad ?? 1)) / MS_DAY);
}

/* ------------------------------- formatting -------------------------------- */

export function formatTimeLabel(timeHHMM: string): string {
  const [hRaw, mRaw] = timeHHMM.split(":");
  const h = Number(hRaw ?? 0);
  const m = Number(mRaw ?? 0);
  const suffix = h < 12 ? "a" : "p";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function runDaysText(runDows: number[]): string {
  if (!runDows.length) return "";
  const uniq = [...new Set(runDows)].sort((a, b) => a - b);
  const names = uniq.map((d) => DOW_SHORT[d] ?? String(d));
  if (names.length === 1) return `${names[0]} run`;
  // A true en-dash range is only honest when the days are genuinely consecutive.
  const consecutive = uniq.every((d, i) => i === 0 || d === uniq[i - 1]! + 1);
  if (consecutive) return `${names[0]}\u2013${names[names.length - 1]} run`;
  if (names.length === 2) return `${names[0]} & ${names[1]} run`;
  return `${names.join(", ")} run`;
}


/* ------------------------------- core engine ------------------------------- */

/**
 * Next occurrence of a single cutoff strictly after `now`.
 * Scans 8 local days so a same-day cutoff that has already passed rolls forward.
 */
export function nextOccurrence(cutoff: RouteCutoff, now: Date): { atUtc: Date; localDate: string } | null {
  if (!cutoff.active) return null;
  const time = cutoff.cutoff_time.slice(0, 5);
  const todayLocal = localDateIn(cutoff.tz, now);
  for (let i = 0; i <= 8; i++) {
    const date = addDaysISO(todayLocal, i);
    if (dowOfISO(date) !== cutoff.cutoff_dow) continue;
    const atUtc = zonedWallToUtc(date, time, cutoff.tz);
    if (atUtc.getTime() > now.getTime()) return { atUtc, localDate: date };
  }
  return null;
}

/** Ship dates fed by a cutoff: the next occurrence of each run_dow after the cutoff date. */
export function runDatesFor(cutoff: RouteCutoff, cutoffLocalDate: string): string[] {
  const dows = [...new Set(cutoff.run_dows ?? [])];
  if (!dows.length) return [];
  const out: string[] = [];
  for (const dow of dows) {
    for (let i = 1; i <= 7; i++) {
      const date = addDaysISO(cutoffLocalDate, i);
      if (dowOfISO(date) === dow) { out.push(date); break; }
    }
  }
  return out.sort();
}

/** The soonest upcoming cutoff across all of a route's cutoffs. */
export function nextCutoff(cutoffs: RouteCutoff[], now: Date): NextCutoff | null {
  let best: NextCutoff | null = null;
  for (const c of cutoffs) {
    const occ = nextOccurrence(c, now);
    if (!occ) continue;
    if (best && occ.atUtc.getTime() >= best.atUtc.getTime()) continue;
    const runDates = runDatesFor(c, occ.localDate);
    const todayLocal = localDateIn(c.tz, now);
    const daysAway = diffDaysISO(todayLocal, occ.localDate);
    const timeLabel = `${DOW_SHORT[c.cutoff_dow] ?? "?"} ${formatTimeLabel(c.cutoff_time)}`;
    const runText = runDaysText(c.run_dows ?? []);
    best = {
      cutoff: c,
      atUtc: occ.atUtc,
      localDate: occ.localDate,
      timeLabel,
      daysAway,
      isToday: daysAway === 0,
      isTomorrow: daysAway === 1,
      runDates,
      windowFrom: runDates[0] ?? null,
      windowTo: runDates[runDates.length - 1] ?? null,
      label: `Orders counted through ${timeLabel}${runText ? ` (${runText})` : ""}`,
    };
  }
  return best;
}

/** True when any cutoff or run day falls on Sat/Sun — drives weekend suppression. */
export function runsWeekend(cutoffs: RouteCutoff[]): boolean {
  return cutoffs.some(
    (c) => c.active && (c.cutoff_dow === 0 || c.cutoff_dow === 6 || (c.run_dows ?? []).some((d) => d === 0 || d === 6)),
  );
}

/** Board sort: today first, then tomorrow, then soonest cutoff; no-cutoff routes last. */
export function cutoffSortKey(next: NextCutoff | null): number {
  if (!next) return Number.MAX_SAFE_INTEGER;
  return next.atUtc.getTime();
}
