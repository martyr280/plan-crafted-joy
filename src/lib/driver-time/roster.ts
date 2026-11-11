// Driver roster shared by Driver rates and the roster hide/restore control.
//
// The roster is never a table of its own. People come from the licensed
// Samsara roster, plus anyone the sweep already stored events for, plus anyone
// with a pay-rate row. Hiding a driver only appends the Samsara id to
// app_settings.driver_time.excludedDriverIds; rate, event and capacity rows
// are never touched, so Restore brings everything back.
//
// No I/O here so the rules are unit-testable.

import { isExcludedDriver } from "./detect";

export type RosterSource = "roster" | "events" | "rates";

export type RosterDriver = { id: string; name: string; source: RosterSource };

export type ExcludedDriver = {
  id: string;
  name: string;
  /** "id": hidden through excludedDriverIds (restorable here). "pattern": a detection name pattern. */
  reason: "id" | "pattern";
  /** Hidden by id and also caught by a name pattern, so Restore alone will not bring them back. */
  alsoMatchesPattern: boolean;
  hasRates: boolean;
};

type Named = { id: string; name?: string | null };
type Row = { driver_id: unknown; driver_name?: string | null };

export type RosterExclusions = {
  excludedDriverIds: readonly string[];
  excludedDriverNamePatterns: readonly string[];
};

export const ROSTER_CONFLICT_MESSAGE =
  "The driver list changed since you loaded it. Refresh the list and try again.";

export const MAX_EXCLUDED_DRIVER_IDS = 500;

/**
 * Active list = filtered Samsara roster, then stored events, then rate rows.
 * Every step honors isExcludedDriver, so a hidden driver with a rate row stays
 * off the active list. Excluded people come back only through `excluded`,
 * which callers expose behind an explicit opt-in.
 */
export function buildDriverRoster(input: {
  /** Samsara roster already passed through filterRoster (exclusions, licence, activation). */
  rosterActive: Named[];
  /** Raw Samsara roster, used only to name hidden drivers. */
  rosterAll: Named[];
  events: Row[];
  rates: Row[];
  settings: RosterExclusions;
}): { active: RosterDriver[]; excluded: ExcludedDriver[] } {
  const { settings } = input;
  const opts = {
    excludedDriverIds: [...settings.excludedDriverIds],
    excludedDriverNamePatterns: [...settings.excludedDriverNamePatterns],
  };
  const active = new Map<string, RosterDriver>();
  for (const d of input.rosterActive) {
    const id = String(d.id);
    if (isExcludedDriver({ id, name: d.name }, opts)) continue;
    active.set(id, { id, name: d.name || id, source: "roster" });
  }
  const addFrom = (rows: Row[], source: RosterSource) => {
    for (const r of rows) {
      const id = String(r.driver_id);
      if (active.has(id) || isExcludedDriver({ id, name: r.driver_name }, opts)) continue;
      active.set(id, { id, name: r.driver_name || id, source });
    }
  };
  addFrom(input.events, "events");
  addFrom(input.rates, "rates");

  const nameOf = new Map<string, string>();
  for (const r of input.rates) if (r.driver_name) nameOf.set(String(r.driver_id), r.driver_name);
  for (const r of input.events) if (r.driver_name) nameOf.set(String(r.driver_id), r.driver_name);
  for (const d of input.rosterAll) if (d.name) nameOf.set(String(d.id), d.name);
  const rated = new Set(input.rates.map((r) => String(r.driver_id)));
  const patternOnly = {
    excludedDriverIds: [],
    excludedDriverNamePatterns: opts.excludedDriverNamePatterns,
  };

  const excluded = new Map<string, ExcludedDriver>();
  for (const raw of settings.excludedDriverIds) {
    const id = String(raw);
    if (excluded.has(id)) continue;
    const name = nameOf.get(id) ?? id;
    excluded.set(id, {
      id,
      name,
      reason: "id",
      alsoMatchesPattern: isExcludedDriver({ id, name }, patternOnly),
      hasRates: rated.has(id),
    });
  }
  // Pattern-excluded people only matter here when they carry rate history.
  for (const r of input.rates) {
    const id = String(r.driver_id);
    if (excluded.has(id) || active.has(id)) continue;
    const name = nameOf.get(id) ?? id;
    excluded.set(id, { id, name, reason: "pattern", alsoMatchesPattern: true, hasRates: true });
  }

  const byName = <T extends { name: string; id: string }>(a: T, b: T) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return {
    active: Array.from(active.values()).sort(byName),
    excluded: Array.from(excluded.values()).sort(byName),
  };
}

/**
 * Next raw app_settings.driver_time value after hiding or restoring one id.
 * Works on the stored JSON as saved (never the defaults-merged view), so every
 * other key, including the saved name patterns, is written back unchanged.
 * `changed: false` means the id is already in the requested state.
 */
export function nextDriverTimeValue(
  saved: unknown,
  driverId: string,
  hidden: boolean,
): { value: Record<string, unknown>; changed: boolean; excludedDriverIds: string[] } {
  if (saved != null && (typeof saved !== "object" || Array.isArray(saved))) {
    throw new Error("Driver Time settings are not in the expected shape. Nothing was changed.");
  }
  const base = { ...((saved ?? {}) as Record<string, unknown>) };
  const current = base.excludedDriverIds;
  if (current != null && !Array.isArray(current)) {
    throw new Error("Saved excluded driver ids are not a list. Nothing was changed.");
  }
  const ids = (current ?? []).map(String);
  const id = String(driverId);
  const present = ids.includes(id);
  if (present === hidden) return { value: base, changed: false, excludedDriverIds: ids };
  const next = hidden ? [...ids, id] : ids.filter((x) => x !== id);
  if (next.length > MAX_EXCLUDED_DRIVER_IDS) {
    throw new Error(`At most ${MAX_EXCLUDED_DRIVER_IDS} drivers can be hidden.`);
  }
  return { value: { ...base, excludedDriverIds: next }, changed: true, excludedDriverIds: next };
}

/**
 * Optimistic check for the roster write. The client's token must match the
 * row it was shown; a missing row is represented by null on both sides.
 */
export function rosterTokenMatches(expected: string | null, current: string | null): boolean {
  return (expected ?? null) === (current ?? null);
}

/**
 * Drivers hidden by id who still have events in a week. The weekly report
 * drops them (and their cost); this lets it say so instead of dropping silently.
 * Pattern-only exclusions (shared LTL / warehouse logins) are not counted.
 */
export function hiddenDriversInEvents(
  events: Array<{ driver_id: unknown }>,
  excludedDriverIds: readonly string[],
): { drivers: number; events: number } {
  const hidden = new Set(excludedDriverIds.map(String));
  const seen = new Set<string>();
  let count = 0;
  for (const ev of events) {
    const id = String(ev.driver_id);
    if (!hidden.has(id)) continue;
    seen.add(id);
    count++;
  }
  return { drivers: seen.size, events: count };
}

export function hiddenRosterNotice(hidden?: { drivers: number; events: number }): string | null {
  if (!hidden?.drivers) return null;
  const who =
    hidden.drivers === 1
      ? "1 driver hidden from the roster has"
      : `${hidden.drivers} drivers hidden from the roster have`;
  const what = `${hidden.events} warehouse event${hidden.events === 1 ? "" : "s"}`;
  return `${who} ${what} in this window. They are not in this report or the estimated cost. Their events and rates are kept; a driver-pay manager can restore them in Settings → Driver roster.`;
}
