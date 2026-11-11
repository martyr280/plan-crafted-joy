// Driver Warehouse Time sweep runner (server-only).
//
// Weekly job: pull the last 8 days of HOS logs for the whole roster, run the
// pure detection engine, and reconcile driver_warehouse_events idempotently.
// Re-pulling 8 days means Samsara log edits get picked up; an event whose
// timing changed after someone reviewed it flips back to `new` so the change
// isn't silently accepted.
//
// No emails, no notifications — this is a report surface.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchDrivers, fetchAddresses } from "@/lib/samsara/hos.server";
import { getDriverTimeInputs } from "@/lib/samsara/cache.server";
import {
  detectWarehouseEvents,
  type HosSegment,
  type WarehouseEvent,
} from "@/lib/driver-time/detect";
import {
  isExcludedDriverOn,
  normalizeExcludedDrivers,
  type DatedExclusion,
} from "@/lib/driver-time/exclusions";
import type { Geofence } from "@/lib/driver-time/geo";
import { CENTRAL_TZ, dateStrInTz, tzOffsetMinutesAt } from "@/lib/driver-time/tz";
import { driverNameKey } from "@/lib/driver-time/reconciliation";

const db = () => supabaseAdmin as any;

export type DriverTimeSettings = {
  warehouseAddressIds: string[];
  thresholdMinutes: number;
  /** Legacy undated id hides: excluded in every week. */
  excludedDriverIds: string[];
  /** Dated id hides from the roster control; see driver-time/exclusions.ts. */
  excludedDrivers: DatedExclusion[];
  excludedDriverNamePatterns: string[];
  mergeGapMinutes: number;
  hubTzByAddress: Record<string, string>;
  /** Shared logins have no licence number; requiring one keeps them out. */
  requireLicense: boolean;
  /** Deactivated drivers keep stale logs that produce phantom 24h blocks. */
  includeDeactivated: boolean;
  /** "presence": any status inside the fence is warehouse time. "onduty": legacy. */
  basis: "presence" | "onduty";
  /** Per-driver: a "Warehouse" HOS remark makes the whole day warehouse time (Joe Green 2026-09-30). Default none. */
  warehouseRemarkDriverIds: string[];
};

export const DEFAULT_DRIVER_TIME_SETTINGS: DriverTimeSettings = {
  warehouseAddressIds: [],
  thresholdMinutes: 90,
  excludedDriverIds: [],
  excludedDrivers: [],
  excludedDriverNamePatterns: [
    "Birmingham LTL",
    "Birmingham Warehouse",
    "Dallas LTL",
    "Dallas Warehouse",
    "Ocala LTL",
    "Ocala Warehouse",
  ],
  mergeGapMinutes: 10,
  hubTzByAddress: {},
  requireLicense: true,
  includeDeactivated: false,
  basis: "presence",
  warehouseRemarkDriverIds: [],
};

export type RosterCounts = {
  total: number;
  excludedByPattern: number;
  excludedNoLicense: number;
  excludedDeactivated: number;
  scanned: number;
};

export type RosterCandidate = {
  id: string;
  name: string;
  licenseNumber?: string | null;
  driverActivationStatus?: string | null;
};

/**
 * Pure roster filter shared by the sweep and diagnostics: name/ID exclusions
 * as of `asOf` (a Central YYYY-MM-DD date) first, then the licence
 * requirement, then activation status.
 */
export function filterRoster<T extends RosterCandidate>(
  drivers: T[],
  settings: Pick<
    DriverTimeSettings,
    "excludedDriverIds" | "excludedDriverNamePatterns" | "requireLicense" | "includeDeactivated"
  > & { excludedDrivers?: DatedExclusion[] },
  asOf: string,
): { roster: T[]; counts: RosterCounts } {
  const counts: RosterCounts = {
    total: drivers.length,
    excludedByPattern: 0,
    excludedNoLicense: 0,
    excludedDeactivated: 0,
    scanned: 0,
  };
  const roster: T[] = [];
  for (const d of drivers) {
    if (isExcludedDriverOn({ id: d.id, name: d.name }, settings, asOf)) {
      counts.excludedByPattern++;
      continue;
    }
    if (settings.requireLicense && !String(d.licenseNumber ?? "").trim()) {
      counts.excludedNoLicense++;
      continue;
    }
    if (!settings.includeDeactivated && (d.driverActivationStatus ?? "active") !== "active") {
      counts.excludedDeactivated++;
      continue;
    }
    roster.push(d);
  }
  counts.scanned = roster.length;
  return { roster, counts };
}

/** Report spellings that differ from the Samsara roster spelling. */
export const REPORT_NAME_ALIASES: Record<string, string> = {
  "ron fugate": "ronald fugate",
  "nelson rolden": "nelson roldan",
};

export type ReportIdentity = {
  driverId: string;
  matched: boolean;
  reason: string;
};

/**
 * Resolve an official-report driver name to a Samsara driver ID. Only
 * licence-holding roster records are candidates, so a shared warehouse login
 * can never absorb a real driver's audited hours. A non-unique or absent match
 * keeps the `report:<hub>:<slug>` fallback and says why.
 */
export function resolveReportDriverIdentity(input: {
  name: string;
  hub: string;
  roster: RosterCandidate[];
}): ReportIdentity {
  const slug = driverNameKey(input.name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const fallback = `report:${input.hub.toLowerCase()}:${slug}`;
  const key = driverNameKey(input.name);
  const target = REPORT_NAME_ALIASES[key] ?? key;
  const licensed = input.roster.filter((d) => String(d.licenseNumber ?? "").trim());
  const matches = licensed.filter((d) => driverNameKey(d.name) === target);
  if (matches.length === 1) {
    return {
      driverId: matches[0].id,
      matched: true,
      reason: `Matched Samsara driver ${matches[0].name} (${matches[0].id}) by name.`,
    };
  }
  return {
    driverId: fallback,
    matched: false,
    reason: matches.length
      ? `Kept report identity: ${matches.length} licensed Samsara drivers share the name "${input.name}".`
      : `Kept report identity: no licensed Samsara driver matches "${input.name}".`,
  };
}

export async function getDriverTimeSettings(): Promise<DriverTimeSettings> {
  const { data, error } = await db()
    .from("app_settings")
    .select("value")
    .eq("key", "driver_time")
    .maybeSingle();
  if (error) throw new Error(error.message);
  const saved = (data?.value ?? {}) as Partial<DriverTimeSettings>;
  return {
    ...DEFAULT_DRIVER_TIME_SETTINGS,
    ...saved,
    requireLicense: saved.requireLicense ?? DEFAULT_DRIVER_TIME_SETTINGS.requireLicense,
    includeDeactivated: saved.includeDeactivated ?? DEFAULT_DRIVER_TIME_SETTINGS.includeDeactivated,
    warehouseRemarkDriverIds: Array.isArray(saved.warehouseRemarkDriverIds)
      ? saved.warehouseRemarkDriverIds.map(String)
      : [],
    basis: saved.basis === "onduty" ? "onduty" : DEFAULT_DRIVER_TIME_SETTINGS.basis,
    excludedDriverIds: Array.isArray(saved.excludedDriverIds)
      ? saved.excludedDriverIds.map(String)
      : [],
    excludedDrivers: normalizeExcludedDrivers(saved.excludedDrivers),
    // Shared warehouse/LTL identities are never individual driver records.
    // Older saved settings must not erase the built-in roster exclusions.
    excludedDriverNamePatterns: [
      ...new Set([
        ...DEFAULT_DRIVER_TIME_SETTINGS.excludedDriverNamePatterns,
        ...(saved.excludedDriverNamePatterns ?? []),
      ]),
    ],
  };
}

/** The stored driver_time row as saved (no defaults merged) and its updated_at token. */
export async function getDriverTimeSettingsRow(): Promise<{
  saved: unknown;
  updatedAt: string | null;
}> {
  const { data, error } = await db()
    .from("app_settings")
    .select("value, updated_at")
    .eq("key", "driver_time")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { saved: data?.value ?? null, updatedAt: data?.updated_at ?? null };
}

/**
 * Compare-and-set write of the raw driver_time row, shared by every settings
 * writer. `mutate` gets the stored JSON (never the defaults-merged view) and
 * returns the next value. The caller's token must match what was read, and the
 * UPDATE only lands while updated_at is still that value; a lost race or an
 * insert collision is a conflict. `changed: false` skips the write.
 */
async function writeDriverTimeRow(
  mutate: (saved: unknown) => { value: Record<string, unknown>; changed: boolean },
  expectedUpdatedAt: string | null,
  conflictMessage: string,
): Promise<{ changed: boolean; updatedAt: string | null; value: Record<string, unknown> }> {
  const { rosterTokenMatches } = await import("@/lib/driver-time/roster");
  const row = await getDriverTimeSettingsRow();
  const next = mutate(row.saved);
  if (!next.changed) return { changed: false, updatedAt: row.updatedAt, value: next.value };
  if (!rosterTokenMatches(expectedUpdatedAt, row.updatedAt)) throw new Error(conflictMessage);
  let stamp = new Date().toISOString();
  if (row.updatedAt && Date.parse(row.updatedAt) >= Date.parse(stamp)) {
    stamp = new Date(Date.parse(row.updatedAt) + 1).toISOString();
  }
  let written: Array<{ updated_at?: string }> | null;
  if (row.updatedAt == null) {
    const { data, error } = await db()
      .from("app_settings")
      .insert({ key: "driver_time", value: next.value, updated_at: stamp })
      .select("updated_at");
    if (error) {
      if (error.code === "23505") throw new Error(conflictMessage);
      throw new Error(error.message);
    }
    written = data;
  } else {
    const { data, error } = await db()
      .from("app_settings")
      .update({ value: next.value, updated_at: stamp })
      .eq("key", "driver_time")
      .eq("updated_at", row.updatedAt)
      .select("updated_at");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error(conflictMessage);
    written = data;
  }
  return { changed: true, updatedAt: written?.[0]?.updated_at ?? stamp, value: next.value };
}

/** Keys only the roster control may write (driver-pay gate, own endpoint). */
export const ROSTER_ONLY_KEYS = ["excludedDriverIds", "excludedDrivers"] as const;

export type DetectionSettingsPatch = Partial<
  Omit<DriverTimeSettings, (typeof ROSTER_ONLY_KEYS)[number]>
>;

/**
 * Detection settings save. Applies the patch to the stored JSON with the same
 * compare-and-set as the roster, and never writes the roster keys: they are
 * dropped from the patch and the stored values are written back as they are,
 * so a Detection save cannot undo a hide and a hide cannot undo a Detection edit.
 */
export async function saveDriverTimeSettings(
  patch: DetectionSettingsPatch,
  expectedUpdatedAt: string | null,
): Promise<{ settings: DriverTimeSettings; updatedAt: string | null }> {
  const { SETTINGS_CONFLICT_MESSAGE } = await import("@/lib/driver-time/roster");
  const safe: Record<string, unknown> = { ...patch };
  for (const k of ROSTER_ONLY_KEYS) delete safe[k];
  const result = await writeDriverTimeRow(
    (saved) => {
      if (saved != null && (typeof saved !== "object" || Array.isArray(saved))) {
        throw new Error("Driver Time settings are not in the expected shape. Nothing was changed.");
      }
      return { value: { ...((saved ?? {}) as Record<string, unknown>), ...safe }, changed: true };
    },
    expectedUpdatedAt,
    SETTINGS_CONFLICT_MESSAGE,
  );
  return { settings: await getDriverTimeSettings(), updatedAt: result.updatedAt };
}

/**
 * Soft-hide or restore one driver by Samsara id. Hide adds a dated entry
 * (hiddenFrom = Monday of the current Central week); Restore removes the id
 * from both the dated and the legacy list. Already-in-state is a no-op
 * success. Only excludedDrivers / excludedDriverIds change.
 */
export async function setDriverRosterHidden(input: {
  driverId: string;
  hidden: boolean;
  expectedUpdatedAt: string | null;
  userId?: string | null;
  now?: Date;
}): Promise<{
  changed: boolean;
  updatedAt: string | null;
  excludedDriverIds: string[];
  hiddenFrom: string | null;
}> {
  const { nextDriverTimeValue, ROSTER_CONFLICT_MESSAGE } = await import("@/lib/driver-time/roster");
  const { hiddenFromFor } = await import("@/lib/driver-time/exclusions");
  const now = input.now ?? new Date();
  const entry = {
    hiddenFrom: hiddenFromFor(now),
    hiddenBy: input.userId ?? null,
    hiddenAt: now.toISOString(),
  };
  let ids: string[] = [];
  const result = await writeDriverTimeRow(
    (saved) => {
      const next = nextDriverTimeValue(saved, input.driverId, input.hidden, entry);
      ids = next.excludedDriverIds;
      return next;
    },
    input.expectedUpdatedAt,
    ROSTER_CONFLICT_MESSAGE,
  );
  return {
    changed: result.changed,
    updatedAt: result.updatedAt,
    excludedDriverIds: ids,
    hiddenFrom: input.hidden && result.changed ? entry.hiddenFrom : null,
  };
}

/** Monday-start week containing `d`, anchored to the Central calendar date. */
export function weekBounds(d: Date): { weekStart: string; weekEnd: string } {
  const central = dateStrInTz(d, CENTRAL_TZ);
  const x = new Date(`${central}T00:00:00Z`);
  const dow = x.getUTCDay(); // 0=Sun
  const back = dow === 0 ? 6 : dow - 1;
  x.setUTCDate(x.getUTCDate() - back);
  const end = new Date(x);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart: x.toISOString().slice(0, 10), weekEnd: end.toISOString().slice(0, 10) };
}

/** Resolve a loose driver timezone string to an IANA zone. */
function ianaZoneFor(tz: string | null | undefined): string {
  const raw = (tz ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower === "america/new_york" || lower === "est" || lower === "edt" || lower === "et") {
    return "America/New_York";
  }
  if (raw.includes("/")) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw }).format(new Date());
      return raw;
    } catch {
      /* fall through */
    }
  }
  return CENTRAL_TZ;
}

/** Hub offset (minutes from UTC) at `at`, DST-aware. */
function offsetForTz(tz: string | null | undefined, at: Date): number {
  return tzOffsetMinutesAt(at, ianaZoneFor(tz));
}

export type SweepResult = {
  ok: boolean;
  runId: string | null;
  weekStart: string;
  weekEnd: string;
  driversScanned: number;
  eventsFound: number;
  inserted: number;
  updated: number;
  reopened: number;
  warnings: string[];
  /** Roster accounting: why drivers were left out of this scan. */
  roster?: RosterCounts;
  error?: string;
};

/**
 * Watchdog: fail any sweep left `running` for more than 15 minutes.
 * Called at the start of every sweep AND on every scheduled tick, so a run
 * killed mid-flight is retired even when no new sweep starts for a week.
 */
export async function failStaleDriverTimeRuns(
  now: Date = new Date(),
): Promise<{ failedIds: string[]; error?: string }> {
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { data, error } = await db()
    .from("driver_warehouse_runs")
    .update({
      status: "failed",
      error: "Timed out: no completion recorded within 15 minutes",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");
  if (error) return { failedIds: [], error: error.message };
  return { failedIds: (data ?? []).map((r: any) => String(r.id)) };
}

export async function runDriverTimeSweep(opts?: {
  now?: Date;
  triggeredBy?: string | null;
  lookbackDays?: number;
  weekStart?: string;
  /** Re-pull HOS logs instead of serving cached days (cached days predating `remark`). */
  refreshHos?: boolean;
}): Promise<SweepResult> {
  const now = opts?.now ?? new Date();
  const lookbackDays = opts?.lookbackDays ?? 8;
  const { weekStart, weekEnd } = opts?.weekStart
    ? selectedWeekBounds(opts.weekStart)
    : weekBounds(now);
  const selectedStart = localMidnight(weekStart, CENTRAL_TZ);
  const selectedEnd = localMidnight(addDays(weekEnd, 1), CENTRAL_TZ);
  const endMs = opts?.weekStart ? Math.min(selectedEnd, now.getTime()) : now.getTime();
  // Include both Eastern and Central local midnight. Filtering below uses
  // driver-local dates, not UTC dates.
  const startMs = opts?.weekStart
    ? Math.min(selectedStart, localMidnight(weekStart, "America/New_York"))
    : endMs - lookbackDays * 86400000;
  if (startMs >= endMs) throw new Error("Cannot scan a future week.");
  const warnings: string[] = [];

  // A run row left `running` means the process died without recording an
  // outcome. Retire stragglers so the runs list never shows a phantom sweep.
  {
    const res = await failStaleDriverTimeRuns(now);
    if (res.error) warnings.push(`stale run cleanup failed: ${res.error}`);
  }

  // The cron sweep reports on the week that just ended: label it with the
  // Monday (Central) of the week containing (run's local date − 7 days).
  // Computed from the run date, not from the scan window (which starts on a
  // Sunday and used to label the previous week).
  const { scheduledSweepWeek } = await import("@/lib/driver-time/week-label");
  const labelWeek = opts?.weekStart ? { weekStart, weekEnd } : scheduledSweepWeek(now);

  const { data: runRow, error: runErr } = await db()
    .from("driver_warehouse_runs")
    .insert({
      week_start: labelWeek.weekStart,
      week_end: labelWeek.weekEnd,
      window_start: new Date(startMs).toISOString(),
      window_end: new Date(endMs).toISOString(),
      status: "running",
      triggered_by: opts?.triggeredBy ?? null,
    })

    .select("id")
    .single();
  if (runErr) throw new Error(runErr.message);
  const runId = runRow.id as string;

  const fail = async (message: string): Promise<SweepResult> => {
    await db()
      .from("driver_warehouse_runs")
      .update({ status: "failed", error: message, completed_at: new Date().toISOString() })
      .eq("id", runId);
    return {
      ok: false,
      runId,
      weekStart,
      weekEnd,
      driversScanned: 0,
      eventsFound: 0,
      inserted: 0,
      updated: 0,
      reopened: 0,
      warnings,
      error: message,
    };
  };

  try {
    const settings = await getDriverTimeSettings();
    const [drivers, addresses] = await Promise.all([fetchDrivers(), fetchAddresses()]);

    const selected = settings.warehouseAddressIds.length
      ? addresses.filter((a) => settings.warehouseAddressIds.includes(a.id))
      : [];
    if (!selected.length) {
      return await fail(
        "No warehouse addresses selected. Pick the warehouse geofences in Driver Time → Settings before running a sweep.",
      );
    }

    const warehouses: Geofence[] = selected.map((a) => ({
      id: a.id,
      name: a.name,
      hub: a.name,
      tz: settings.hubTzByAddress[a.id] ?? null,
      circle: a.circle,
      polygon: a.polygon,
    }));

    // Scan anyone visible on any day of the window; the weekly report drops
    // events on or after a dated hide.
    const { roster, counts: rosterCounts } = filterRoster(
      drivers,
      settings,
      dateStrInTz(new Date(startMs), CENTRAL_TZ),
    );
    if (!roster.length)
      return await fail(
        `No drivers to scan after exclusions (roster ${rosterCounts.total}, pattern ${rosterCounts.excludedByPattern}, no licence ${rosterCounts.excludedNoLicense}, deactivated ${rosterCounts.excludedDeactivated}).`,
      );

    // All Samsara reads go through the cached data layer, so a rescan of the
    // same days reuses what a prior sweep or probe already pulled. Assignments
    // fill in the vehicle on segments Samsara reported without one, which is
    // what makes GPS evidence available for those blocks.
    const inputs = await getDriverTimeInputs({
      startMs,
      endMs,
      driverIds: roster.map((d) => d.id),
      refreshHos: opts?.refreshHos === true,
    });
    const segments = inputs.segments;
    const gpsSamples = inputs.gpsSamples;

    const byDriver = new Map<string, HosSegment[]>();
    for (const s of segments) {
      const arr = byDriver.get(s.driverId) ?? [];
      arr.push(s as HosSegment);
      byDriver.set(s.driverId, arr);
    }

    const events: WarehouseEvent[] = [];
    for (const d of roster) {
      const segs = byDriver.get(d.id);
      if (!segs?.length) continue;
      const tzOffsetMinutes = offsetForTz(d.timezone, new Date(startMs));
      events.push(
        ...detectWarehouseEvents({
          driver: { id: d.id, name: d.name },
          segments: segs,
          warehouses,
          gpsSamples,
          options: {
            thresholdMinutes: settings.thresholdMinutes,
            mergeGapMinutes: settings.mergeGapMinutes,
            eldDayStartHour: d.eldDayStartHour ?? 0,
            tzOffsetMinutes,
            excludedDriverIds: settings.excludedDriverIds,
            excludedDriverNamePatterns: settings.excludedDriverNamePatterns,
            basis: settings.basis,
            hubTags: (d as any).tags ?? [],
            remarkRule: settings.warehouseRemarkDriverIds.includes(d.id),
          },
        }),
      );
    }

    // Reconcile.
    let inserted = 0;
    let updated = 0;
    let reopened = 0;

    const { data: existing, error: existingError } = await db()
      .from("driver_warehouse_events")
      .select("id, driver_id, start_ts, end_ts, duration_min, status, superseded_at")
      .gte("start_ts", new Date(startMs).toISOString())
      .lt("start_ts", new Date(endMs).toISOString())
      .limit(10000);
    if (existingError) throw new Error(existingError.message);
    if ((existing?.length ?? 0) >= 10000)
      throw new Error("Rescan range exceeds the reconciliation limit.");
    const existingMap = new Map<string, any>();
    for (const row of existing ?? []) {
      existingMap.set(`${row.driver_id}|${new Date(row.start_ts).toISOString()}`, row);
    }

    const seen = new Set<string>();
    for (const ev of events) {
      if (opts?.weekStart && (ev.eventDate < weekStart || ev.eventDate > weekEnd)) continue;
      const startIso = new Date(ev.startMs).toISOString();
      const eventKey = `${ev.driverId}|${startIso}`;
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      const prior = existingMap.get(eventKey);
      const payload = {
        run_id: runId,
        driver_id: ev.driverId,
        driver_name: ev.driverName,
        event_date: ev.eventDate,
        start_ts: startIso,
        end_ts: new Date(ev.endMs).toISOString(),
        duration_min: ev.durationMin,
        address_id: ev.addressId,
        address_name: ev.addressName,
        hub: ev.hub,
        statuses: ev.statuses,
        location_source: ev.locationSource,
        needs_review: ev.needsReview,
        superseded_at: null,
        // Remark-rule events carry the remark text; other events leave reviewer notes alone.
        ...(ev.locationSource === "remark" && ev.notes ? { notes: ev.notes } : {}),
      };

      if (!prior) {
        const { error } = await db()
          .from("driver_warehouse_events")
          .insert({ ...payload, status: "new" });
        if (error)
          warnings.push(
            `insert failed for ${ev.driverName ?? ev.driverId} @ ${startIso}: ${error.message}`,
          );
        else inserted++;
        continue;
      }

      const timingChanged =
        prior.duration_min !== ev.durationMin ||
        new Date(prior.end_ts).toISOString() !== payload.end_ts;
      const patch: any = { ...payload };
      if (timingChanged && prior.status !== "new") {
        patch.status = "new";
        patch.reviewed_by = null;
        patch.reviewed_at = null;
        reopened++;
      }
      const { error } = await db().from("driver_warehouse_events").update(patch).eq("id", prior.id);
      if (error) warnings.push(`update failed for id ${prior.id}: ${error.message}`);
      else updated++;
    }

    if (warnings.some((w) => w.startsWith("insert failed") || w.startsWith("update failed")))
      throw new Error(`Event reconciliation incomplete: ${warnings.join(" | ")}`);
    // Retire only fully enclosed events for scanned drivers after a complete
    // fetch/write pass. Preserve the old rows for review and source comparison.
    // Retire stale rows for scanned drivers AND for every roster driver now
    // excluded from the scan — those events can never be regenerated.
    const scanned = new Set(roster.map((d) => d.id));
    const known = new Set(drivers.map((d) => String(d.id)));
    const retirable = (id: string) => scanned.has(id) || known.has(id);
    type ExistingEvent = {
      id: string;
      driver_id: string;
      start_ts: string;
      end_ts: string;
      superseded_at: string | null;
    };
    const stale = ((existing ?? []) as ExistingEvent[]).filter(
      (e) =>
        retirable(String(e.driver_id)) &&
        !e.superseded_at &&
        Date.parse(e.start_ts) > startMs &&
        Date.parse(e.end_ts) < endMs &&
        !seen.has(`${e.driver_id}|${new Date(e.start_ts).toISOString()}`),
    );
    for (let i = 0; i < stale.length; i += 200) {
      const { error } = await db()
        .from("driver_warehouse_events")
        .update({ superseded_at: new Date().toISOString() })
        .in(
          "id",
          stale.slice(i, i + 200).map((e) => e.id),
        );
      if (error) throw new Error(error.message);
    }
    await db()
      .from("driver_warehouse_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        drivers_scanned: roster.length,
        events_found: events.length,
        error: warnings.length ? warnings.slice(0, 5).join(" | ") : null,
      })
      .eq("id", runId);

    return {
      ok: true,
      runId,
      weekStart,
      weekEnd,
      driversScanned: roster.length,
      eventsFound: events.length,
      inserted,
      updated,
      reopened,
      warnings,
      roster: rosterCounts,
    };
  } catch (e: any) {
    return await fail(e?.message ?? String(e));
  }
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function localMidnight(date: string, zone: string) {
  const anchor = Date.parse(`${date}T12:00:00Z`);
  return Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutesAt(new Date(anchor), zone) * 60000;
}
export function selectedWeekBounds(weekStart: string) {
  const d = new Date(`${weekStart}T00:00:00Z`);
  if (
    !Number.isFinite(d.getTime()) ||
    d.toISOString().slice(0, 10) !== weekStart ||
    d.getUTCDay() !== 1
  )
    throw new Error("Select a valid Monday.");
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}
