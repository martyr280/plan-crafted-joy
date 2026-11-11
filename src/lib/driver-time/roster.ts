// Driver roster shared by Driver rates and the roster hide/restore control.
//
// The roster is never a table of its own. People come from the licensed
// Samsara roster, plus anyone the sweep already stored events for, plus anyone
// with a pay-rate row. Hiding a driver only adds a dated entry to
// app_settings.driver_time.excludedDrivers; rate, event and capacity rows are
// never touched, so Restore brings everything back. Whether a driver is
// excluded on a date is decided only by ./exclusions.
//
// No I/O here so the rules are unit-testable.

import {
  idExclusionFor,
  isExcludedDriverOn,
  isIdExcludedOn,
  matchesNamePattern,
  type DatedExclusion,
  type ExclusionSettings,
} from "./exclusions";
import { driverNameKey } from "./reconciliation";

export type RosterSource = "roster" | "events" | "rates";

export type RosterDriver = { id: string; name: string; source: RosterSource };

export type ExcludedDriver = {
  id: string;
  name: string;
  /** "id": hidden by id (restorable here). "pattern": a detection name pattern. */
  reason: "id" | "pattern";
  /** First hidden week (Monday, Central). null: hidden in every week (older hide). */
  hiddenFrom: string | null;
  /** Hidden by a name pattern as well, so Restore alone will not bring them back. */
  alsoMatchesPattern: boolean;
  hasRates: boolean;
};

type Named = { id: string; name?: string | null };
type Row = { driver_id: unknown; driver_name?: string | null };

export type RosterExclusions = {
  excludedDriverIds: readonly string[];
  excludedDriverNamePatterns: readonly string[];
  excludedDrivers: readonly DatedExclusion[];
};

export const ROSTER_CONFLICT_MESSAGE =
  "The driver list changed since you loaded it. Refresh the list and try again.";

export const SETTINGS_CONFLICT_MESSAGE =
  "Driver Time settings changed since you loaded them. Refresh the settings and try again.";

export const MAX_EXCLUDED_DRIVER_IDS = 500;

/**
 * Active list = filtered Samsara roster, then stored events, then rate rows,
 * each checked with isExcludedDriverOn as of `asOf` (today, Central). A driver
 * hidden this week with a rate row stays off the active list. Excluded people
 * come back only through `excluded`, which callers expose behind an opt-in.
 */
export function buildDriverRoster(input: {
  /** Samsara roster already passed through filterRoster as of the same date. */
  rosterActive: Named[];
  /** Raw Samsara roster, used only to name hidden drivers. */
  rosterAll: Named[];
  events: Row[];
  rates: Row[];
  settings: RosterExclusions;
  asOf: string;
}): { active: RosterDriver[]; excluded: ExcludedDriver[]; patternMatchedIds: string[] } {
  const { settings, asOf } = input;
  const active = new Map<string, RosterDriver>();
  for (const d of input.rosterActive) {
    const id = String(d.id);
    if (isExcludedDriverOn({ id, name: d.name }, settings, asOf)) continue;
    active.set(id, { id, name: d.name || id, source: "roster" });
  }
  const addFrom = (rows: Row[], source: RosterSource) => {
    for (const r of rows) {
      const id = String(r.driver_id);
      if (active.has(id) || isExcludedDriverOn({ id, name: r.driver_name }, settings, asOf))
        continue;
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

  const excluded = new Map<string, ExcludedDriver>();
  const hiddenIds = [
    ...settings.excludedDriverIds.map(String),
    ...settings.excludedDrivers.map((e) => String(e.id)),
  ];
  for (const id of hiddenIds) {
    if (excluded.has(id)) continue;
    const x = idExclusionFor(id, settings);
    const name = nameOf.get(id) ?? id;
    excluded.set(id, {
      id,
      name,
      reason: "id",
      hiddenFrom: x?.kind === "dated" && x.from ? x.from : null,
      alsoMatchesPattern: matchesNamePattern(name, settings),
      hasRates: rated.has(id),
    });
  }
  // Pattern-excluded people only matter here when they carry rate history.
  for (const r of input.rates) {
    const id = String(r.driver_id);
    if (excluded.has(id) || active.has(id)) continue;
    const name = nameOf.get(id) ?? id;
    excluded.set(id, {
      id,
      name,
      reason: "pattern",
      hiddenFrom: null,
      alsoMatchesPattern: true,
      hasRates: true,
    });
  }

  const byName = <T extends { name: string; id: string }>(a: T, b: T) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const patternMatchedIds = new Set<string>();
  for (const [id, name] of nameOf)
    if (matchesNamePattern(name, settings)) patternMatchedIds.add(id);
  for (const d of excluded.values()) if (d.alsoMatchesPattern) patternMatchedIds.add(d.id);
  return {
    active: Array.from(active.values()).sort(byName),
    excluded: Array.from(excluded.values()).sort(byName),
    patternMatchedIds: Array.from(patternMatchedIds).sort(),
  };
}

export type HideEntry = { hiddenFrom: string; hiddenBy: string | null; hiddenAt: string };

/**
 * Next raw app_settings.driver_time value after hiding or restoring one id.
 * Works on the stored JSON as saved (never the defaults-merged view), so every
 * other key, including the saved name patterns, is written back unchanged.
 *
 * Hide adds { id, hiddenFrom, hiddenBy, hiddenAt } to excludedDrivers unless
 * the id is already hidden (legacy or dated). Restore removes the id from both
 * lists. `changed: false` means the id is already in the requested state.
 */
export function nextDriverTimeValue(
  saved: unknown,
  driverId: string,
  hidden: boolean,
  entry: HideEntry,
): {
  value: Record<string, unknown>;
  changed: boolean;
  excludedDriverIds: string[];
  excludedDrivers: unknown[];
} {
  if (saved != null && (typeof saved !== "object" || Array.isArray(saved))) {
    throw new Error("Driver Time settings are not in the expected shape. Nothing was changed.");
  }
  const base = { ...((saved ?? {}) as Record<string, unknown>) };
  const legacyRaw = base.excludedDriverIds;
  if (legacyRaw != null && !Array.isArray(legacyRaw)) {
    throw new Error("Saved excluded driver ids are not a list. Nothing was changed.");
  }
  const datedRaw = base.excludedDrivers;
  if (datedRaw != null && !Array.isArray(datedRaw)) {
    throw new Error("Saved hidden drivers are not a list. Nothing was changed.");
  }
  const legacy = (legacyRaw ?? []).map(String);
  const dated = [...((datedRaw ?? []) as unknown[])];
  const id = String(driverId);
  const datedId = (e: unknown) =>
    e && typeof e === "object" ? String((e as { id?: unknown }).id) : null;
  const present = legacy.includes(id) || dated.some((e) => datedId(e) === id);
  const unchanged = {
    value: base,
    changed: false,
    excludedDriverIds: legacy,
    excludedDrivers: dated,
  };
  if (present === hidden) return unchanged;

  if (!hidden) {
    const nextLegacy = legacy.filter((x) => x !== id);
    const nextDated = dated.filter((e) => datedId(e) !== id);
    const value = { ...base };
    if (legacyRaw != null || nextLegacy.length) value.excludedDriverIds = nextLegacy;
    if (datedRaw != null || nextDated.length) value.excludedDrivers = nextDated;
    return { value, changed: true, excludedDriverIds: nextLegacy, excludedDrivers: nextDated };
  }

  if (legacy.length + dated.length + 1 > MAX_EXCLUDED_DRIVER_IDS) {
    throw new Error(`At most ${MAX_EXCLUDED_DRIVER_IDS} drivers can be hidden.`);
  }
  const nextDated = [
    ...dated,
    { id, hiddenFrom: entry.hiddenFrom, hiddenBy: entry.hiddenBy, hiddenAt: entry.hiddenAt },
  ];
  return {
    value: { ...base, excludedDrivers: nextDated },
    changed: true,
    excludedDriverIds: legacy,
    excludedDrivers: nextDated,
  };
}

/**
 * Optimistic check for the roster write. The client's token must match the
 * row it was shown; a missing row is represented by null on both sides.
 */
export function rosterTokenMatches(expected: string | null, current: string | null): boolean {
  return (expected ?? null) === (current ?? null);
}

export type HiddenByRoster = { drivers: number; events: number; officialTotals: number };

type WeekEvent = {
  driver_id: unknown;
  driver_name?: string | null;
  event_date: string;
  hub?: string | null;
};
type WeekOverride = { driver_id: unknown; warehouse_actual?: Record<string, unknown> | null };

/**
 * Applies roster exclusions to one report week's inputs.
 *
 * Events are checked on their own date. Official warehouse actuals are a
 * whole-week record, so they are checked as of the week start; dated hides
 * always begin on a Monday, which makes the two agree. A historical
 * "report:" official row is dropped when it would join (same hub, same exact
 * normalized name) to a driver hidden by id that week, matching the join in
 * buildReconciledDrivers.
 *
 * Only id hides are counted in `hidden`; pattern exclusions (shared LTL /
 * warehouse logins) drop silently as before. Override rows without an official
 * actual are kept: they only carry Paycom hours and revisions for drivers that
 * appear for other reasons.
 */
export function scopeWeekInputs<E extends WeekEvent, O extends WeekOverride>(input: {
  events: E[];
  overrides: O[];
  settings: ExclusionSettings;
  weekStart: string;
}): { events: E[]; overrides: O[]; hidden: HiddenByRoster } {
  const { settings, weekStart } = input;
  const hiddenDrivers = new Set<string>();
  let hiddenEvents = 0;
  let hiddenOfficial = 0;
  const hiddenNames = new Map<string, string>();

  const events = input.events.filter((ev) => {
    const id = String(ev.driver_id);
    if (!isExcludedDriverOn({ id, name: ev.driver_name }, settings, ev.event_date)) return true;
    if (isIdExcludedOn(id, settings, ev.event_date)) {
      hiddenDrivers.add(id);
      hiddenEvents++;
    }
    return false;
  });
  for (const ev of input.events) {
    const id = String(ev.driver_id);
    if (ev.driver_name && isIdExcludedOn(id, settings, weekStart)) {
      hiddenNames.set(`${ev.hub ?? ""}|${driverNameKey(ev.driver_name)}`, id);
    }
  }

  const overrides = input.overrides.filter((o) => {
    const a = o.warehouse_actual;
    if (a == null) return true;
    const id = String(o.driver_id);
    const name = typeof a.driverName === "string" ? a.driverName : "";
    const hub = typeof a.hub === "string" ? a.hub : "";
    if (isIdExcludedOn(id, settings, weekStart)) {
      hiddenDrivers.add(id);
      hiddenOfficial++;
      return false;
    }
    if (id.startsWith("report:") && name) {
      const alias = hiddenNames.get(`${hub}|${driverNameKey(name)}`);
      if (alias) {
        hiddenDrivers.add(alias);
        hiddenOfficial++;
        return false;
      }
    }
    return !matchesNamePattern(name, settings);
  });

  return {
    events,
    overrides,
    hidden: { drivers: hiddenDrivers.size, events: hiddenEvents, officialTotals: hiddenOfficial },
  };
}

export function hiddenRosterNotice(hidden?: Partial<HiddenByRoster>): string | null {
  if (!hidden?.drivers) return null;
  const events = hidden.events ?? 0;
  const official = hidden.officialTotals ?? 0;
  const parts: string[] = [];
  if (events) parts.push(`${events} warehouse event${events === 1 ? "" : "s"}`);
  if (official) parts.push(`${official} official weekly total${official === 1 ? "" : "s"}`);
  const who =
    hidden.drivers === 1
      ? "1 driver hidden in Driver roster has"
      : `${hidden.drivers} drivers hidden in Driver roster have`;
  return `${who} ${parts.join(" and ")} in this window. This report's time totals and estimated cost do not include them. New hides apply from their shown start week; older hides and name rules may exclude all weeks. Stored events, official totals and rates are kept. An admin or logistics admin can review the hide and any name rule in Settings → Driver roster.`;
}
