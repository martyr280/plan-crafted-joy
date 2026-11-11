// The one place that decides whether a driver is excluded on a given date.
//
// Settings (app_settings.driver_time) carry three kinds of exclusion:
//   - excludedDriverNamePatterns: case-insensitive substrings for shared
//     LTL / warehouse logins. Every date.
//   - excludedDriverIds: legacy, undated id hides. Every date.
//   - excludedDrivers: dated id hides, [{ id, hiddenFrom, hiddenBy?, hiddenAt? }].
//
// Boundary rule for dated hides: hiddenFrom is an America/Chicago calendar
// date. A hide takes effect from the Monday of the week containing hiddenFrom
// (a non-Monday value rounds down), and the driver is excluded on every date
// on or after that Monday. Weeks before it keep the driver, so past reports
// and costs do not change. The roster writes hiddenFrom as the Monday of the
// current Central week, so a hide applies to the current week onward.
//
// Pure: no I/O, so every reader can share it and it is unit-testable.

import { dateStrInTz } from "./tz";

export type DatedExclusion = {
  id: string;
  hiddenFrom: string;
  hiddenBy?: string | null;
  hiddenAt?: string | null;
};

export type ExclusionSettings = {
  excludedDriverIds?: readonly string[];
  excludedDriverNamePatterns?: readonly string[];
  excludedDrivers?: readonly DatedExclusion[];
};

type Driver = { id: unknown; name?: string | null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Monday of the week containing a YYYY-MM-DD date. */
export function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

/** hiddenFrom for a hide made at `now`: Monday of the current Central week. */
export function hiddenFromFor(now: Date): string {
  return mondayOf(dateStrInTz(now));
}

/**
 * Dated entries from a raw settings value. Entries without an id are dropped.
 * An entry whose hiddenFrom is not a real date stays hidden on every date
 * (null), because the intent to hide is explicit and the start is unknown.
 */
export function normalizeExcludedDrivers(raw: unknown): DatedExclusion[] {
  if (!Array.isArray(raw)) return [];
  const out: DatedExclusion[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (r.id == null || String(r.id).trim() === "") continue;
    out.push({
      id: String(r.id),
      hiddenFrom: isDateStr(r.hiddenFrom) ? r.hiddenFrom : "",
      hiddenBy: typeof r.hiddenBy === "string" ? r.hiddenBy : null,
      hiddenAt: typeof r.hiddenAt === "string" ? r.hiddenAt : null,
    });
  }
  return out;
}

/** First excluded date for a dated entry; "" means every date. */
export function effectiveHiddenFrom(e: Pick<DatedExclusion, "hiddenFrom">): string {
  return isDateStr(e.hiddenFrom) ? mondayOf(e.hiddenFrom) : "";
}

export type IdExclusion = { kind: "legacy" } | { kind: "dated"; from: string };

/** The id-based hide for a driver (legacy wins over dated), or null. */
export function idExclusionFor(id: unknown, settings: ExclusionSettings): IdExclusion | null {
  const key = String(id);
  if ((settings.excludedDriverIds ?? []).map(String).includes(key)) return { kind: "legacy" };
  let from: string | null = null;
  for (const e of settings.excludedDrivers ?? []) {
    if (String(e.id) !== key) continue;
    const f = effectiveHiddenFrom(e);
    if (from === null || f < from) from = f;
  }
  return from === null ? null : { kind: "dated", from };
}

/** Excluded by an id hide (legacy or dated) on `date`. Name patterns ignored. */
export function isIdExcludedOn(id: unknown, settings: ExclusionSettings, date: string): boolean {
  const x = idExclusionFor(id, settings);
  if (!x) return false;
  return x.kind === "legacy" || date >= x.from;
}

/** Same case-insensitive substring rule as detect.ts isExcludedDriver. */
export function matchesNamePattern(name: string | null | undefined, settings: ExclusionSettings) {
  const n = (name ?? "").toLowerCase();
  if (!n) return false;
  return (settings.excludedDriverNamePatterns ?? []).some(
    (p) => p.trim().length > 0 && n.includes(p.trim().toLowerCase()),
  );
}

/** Whether a driver is excluded on a Central calendar date (YYYY-MM-DD). */
export function isExcludedDriverOn(
  driver: Driver,
  settings: ExclusionSettings,
  date: string,
): boolean {
  return isIdExcludedOn(driver.id, settings, date) || matchesNamePattern(driver.name, settings);
}
