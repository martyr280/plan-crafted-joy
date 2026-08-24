// Pure create-or-patch decision for Samsara Route Dispatch.
//
// Every hard Samsara rule lives HERE and nowhere else:
//
//  * PATCH /fleet/routes/{id} takes sparse top-level fields, but the `stops`
//    array OVERWRITES. A retained stop that omits its Samsara stop `id` is
//    DELETED. So every retained stop echoes its id.
//  * Only future-scheduled stops may be modified on an in-progress route.
//    Modifying a past-time stop is documented "unpredictable behavior", so any
//    stop whose existing scheduledArrivalTime <= now is copied through
//    byte-identical: same id, same time, same fields, never reordered out.
//  * Past the lock instant nothing is touched at all.
//  * driverId / vehicleId present in Samsara but absent from our plan is
//    treated as Samsara-owned (a dispatcher assigned it) and echoed back,
//    never cleared.

import type { DispatchPlanRun } from "./build";

export type SamsaraStop = {
  id?: string;
  name?: string;
  scheduledArrivalTime?: string;
  addressId?: string;
  notes?: string;
  externalIds?: Record<string, string>;
  [k: string]: unknown;
};

export type SamsaraRoute = {
  id?: string;
  name?: string;
  driverId?: string | null;
  vehicleId?: string | null;
  externalIds?: Record<string, string>;
  stops?: SamsaraStop[];
  [k: string]: unknown;
};

export type DiffResult =
  | { action: "noop"; reason: string; payload: null }
  | { action: "create"; payload: SamsaraRoute; reason: string }
  | { action: "patch"; routeId: string; payload: SamsaraRoute; reason: string };

export type DiffOptions = {
  /** Driver/vehicle our plan wants; omit to leave assignment to Samsara. */
  driverId?: string | null;
  vehicleId?: string | null;
  routeNamePrefix?: string;
};

export function routeNameFor(run: DispatchPlanRun, prefix = "NDI"): string {
  return `${prefix} ${run.routeCode} ${run.runDate}${run.runSeq > 1 ? ` #${run.runSeq}` : ""}`;
}

/** Plan stop -> Samsara stop payload (no id: it does not exist in Samsara yet). */
function planStopPayload(run: DispatchPlanRun, stop: DispatchPlanRun["stops"][number]): SamsaraStop {
  return {
    name: stop.customerName ?? stop.orderNo ?? `Stop ${stop.position}`,
    addressId: stop.samsaraAddressId ?? undefined,
    scheduledArrivalTime: stop.scheduledArrival,
    notes: stop.stopNotes ?? undefined,
    externalIds: {
      nelsonStop: `${run.externalId}:${stop.orderNo ?? ""}:${stop.p21ShipToId ?? ""}`,
    },
  };
}

function stopKey(s: SamsaraStop): string {
  return String(s.externalIds?.["nelsonStop"] ?? s.id ?? s.name ?? "");
}

function isPast(s: SamsaraStop, now: Date): boolean {
  const t = Date.parse(String(s.scheduledArrivalTime ?? ""));
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime();
}

/**
 * Decide what to send to Samsara for one plan run.
 * `existing` is the GET /fleet/routes result for the run's externalId, or null.
 */
export function diffRun(
  run: DispatchPlanRun,
  existing: SamsaraRoute | null,
  now: Date,
  options: DiffOptions = {},
): DiffResult {
  const lockMs = run.lockAtIso ? Date.parse(run.lockAtIso) : NaN;
  if (Number.isFinite(lockMs) && now.getTime() >= lockMs) {
    return { action: "noop", reason: "locked", payload: null };
  }

  const name = routeNameFor(run, options.routeNamePrefix);
  const planStops = run.stops.map((s) => planStopPayload(run, s));

  if (!existing || !existing.id) {
    // Samsara requires at least two stops on a route.
    if (planStops.length < 2) {
      return { action: "noop", reason: "insufficient_stops", payload: null };
    }
    const payload: SamsaraRoute = {
      name,
      externalIds: { nelsonDispatch: run.externalId },
      stops: planStops,
    };
    if (options.driverId) payload.driverId = options.driverId;
    else if (options.vehicleId) payload.vehicleId = options.vehicleId;
    return { action: "create", payload, reason: "no_existing_route" };
  }

  const existingStops = existing.stops ?? [];
  // 1. Past stops pass through byte-identical, in their original order.
  const pastStops = existingStops.filter((s) => isPast(s, now));
  const pastKeys = new Set(pastStops.map(stopKey));

  // 2. Future stops: keep the plan's intent, but echo the Samsara stop id of
  //    any stop we can identify so PATCH updates rather than deletes+recreates.
  const futureById = new Map<string, SamsaraStop>();
  for (const s of existingStops) {
    if (isPast(s, now)) continue;
    const k = stopKey(s);
    if (k) futureById.set(k, s);
  }

  const futureStops: SamsaraStop[] = [];
  for (const ps of planStops) {
    const k = stopKey(ps);
    // Never re-emit a stop that already happened under a different payload.
    if (k && pastKeys.has(k)) continue;
    const match = k ? futureById.get(k) : undefined;
    futureStops.push(match?.id ? { ...ps, id: match.id } : ps);
  }

  const payload: SamsaraRoute = {
    name,
    externalIds: { nelsonDispatch: run.externalId },
    // Order: history first, then the future plan. Samsara sequences by time
    // anyway; keeping past stops first makes the payload readable in audits.
    stops: [...pastStops, ...futureStops],
  };

  // 3. Assignment: our plan wins if it has one; otherwise echo Samsara's.
  if (options.driverId) payload.driverId = options.driverId;
  else if (options.vehicleId) payload.vehicleId = options.vehicleId;
  else if (existing.driverId) payload.driverId = existing.driverId;
  else if (existing.vehicleId) payload.vehicleId = existing.vehicleId;

  const unchanged =
    existing.name === payload.name &&
    JSON.stringify(existingStops) === JSON.stringify(payload.stops) &&
    (existing.driverId ?? null) === (payload.driverId ?? null) &&
    (existing.vehicleId ?? null) === (payload.vehicleId ?? null);
  if (unchanged) return { action: "noop", reason: "in_sync", payload: null };

  if (payload.stops!.length < 2) {
    return { action: "noop", reason: "insufficient_stops", payload: null };
  }

  return { action: "patch", routeId: String(existing.id), payload, reason: "delta" };
}
