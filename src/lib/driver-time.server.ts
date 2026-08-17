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
import { fetchDrivers, fetchAddresses, fetchHosLogs, fetchVehicleGpsHistory } from "@/lib/samsara/hos.server";
import { detectWarehouseEvents, isExcludedDriver, type HosSegment, type WarehouseEvent } from "@/lib/driver-time/detect";
import type { Geofence } from "@/lib/driver-time/geo";
import { CENTRAL_TZ, dateStrInTz, tzOffsetMinutesAt } from "@/lib/driver-time/tz";

const db = () => supabaseAdmin as any;

export type DriverTimeSettings = {
  warehouseAddressIds: string[];
  thresholdMinutes: number;
  excludedDriverIds: string[];
  excludedDriverNamePatterns: string[];
  mergeGapMinutes: number;
  hubTzByAddress: Record<string, string>;
};

export const DEFAULT_DRIVER_TIME_SETTINGS: DriverTimeSettings = {
  warehouseAddressIds: [],
  thresholdMinutes: 90,
  excludedDriverIds: [],
  excludedDriverNamePatterns: ["Birmingham LTL", "Birmingham Warehouse"],
  mergeGapMinutes: 10,
  hubTzByAddress: {},
};

export async function getDriverTimeSettings(): Promise<DriverTimeSettings> {
  const { data } = await db().from("app_settings").select("value").eq("key", "driver_time").maybeSingle();
  return { ...DEFAULT_DRIVER_TIME_SETTINGS, ...((data?.value ?? {}) as Partial<DriverTimeSettings>) };
}

export async function saveDriverTimeSettings(patch: Partial<DriverTimeSettings>): Promise<DriverTimeSettings> {
  const next = { ...(await getDriverTimeSettings()), ...patch };
  const { error } = await db()
    .from("app_settings")
    .upsert({ key: "driver_time", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return next;
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
  error?: string;
};

export async function runDriverTimeSweep(opts?: {
  now?: Date;
  triggeredBy?: string | null;
  lookbackDays?: number;
}): Promise<SweepResult> {
  const now = opts?.now ?? new Date();
  const lookbackDays = opts?.lookbackDays ?? 8;
  const { weekStart, weekEnd } = weekBounds(now);
  const warnings: string[] = [];

  const { data: runRow, error: runErr } = await db()
    .from("driver_warehouse_runs")
    .insert({ week_start: weekStart, week_end: weekEnd, status: "running", triggered_by: opts?.triggeredBy ?? null })
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
      ok: false, runId, weekStart, weekEnd, driversScanned: 0, eventsFound: 0,
      inserted: 0, updated: 0, reopened: 0, warnings, error: message,
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

    const roster = drivers.filter(
      (d) =>
        !isExcludedDriver(
          { id: d.id, name: d.name },
          {
            excludedDriverIds: settings.excludedDriverIds,
            excludedDriverNamePatterns: settings.excludedDriverNamePatterns,
          },
        ),
    );
    if (!roster.length) return await fail("No drivers to scan after exclusions.");

    const endMs = Math.min(Date.parse(`${weekEnd}T23:59:59Z`), now.getTime());
    const startMs = endMs - lookbackDays * 86_400_000;

    const segments = await fetchHosLogs({ startMs, endMs, driverIds: roster.map((d) => d.id) });

    // GPS fallback for blocks whose log carried no coordinates. Best-effort.
    let gpsSamples: Array<{ vehicleId: string; timeMs: number; latitude: number; longitude: number }> = [];
    const needGps = segments.some((s) => s.latitude === null || s.longitude === null);
    if (needGps) {
      const vehicleIds = Array.from(new Set(segments.map((s) => s.vehicleId).filter(Boolean) as string[]));
      try {
        gpsSamples = await fetchVehicleGpsHistory({ startMs, endMs, vehicleIds });
      } catch (e: any) {
        warnings.push(`GPS fallback unavailable: ${e?.message ?? String(e)}`);
      }
    }

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
      const tzOffsetMinutes = offsetForTz(d.timezone, now);
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
          },
        }),
      );
    }

    // Reconcile.
    let inserted = 0;
    let updated = 0;
    let reopened = 0;

    const { data: existing } = await db()
      .from("driver_warehouse_events")
      .select("id, driver_id, start_ts, end_ts, duration_min, status")
      .gte("event_date", new Date(startMs).toISOString().slice(0, 10))
      .limit(10000);
    const existingMap = new Map<string, any>();
    for (const row of existing ?? []) {
      existingMap.set(`${row.driver_id}|${new Date(row.start_ts).toISOString()}`, row);
    }

    for (const ev of events) {
      const startIso = new Date(ev.startMs).toISOString();
      const prior = existingMap.get(`${ev.driverId}|${startIso}`);
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
      };

      if (!prior) {
        const { error } = await db().from("driver_warehouse_events").insert({ ...payload, status: "new" });
        if (error) warnings.push(`insert failed for ${ev.driverName ?? ev.driverId} @ ${startIso}: ${error.message}`);
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
      ok: true, runId, weekStart, weekEnd,
      driversScanned: roster.length, eventsFound: events.length,
      inserted, updated, reopened, warnings,
    };
  } catch (e: any) {
    return await fail(e?.message ?? String(e));
  }
}
