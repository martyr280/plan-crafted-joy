// Server-only Samsara Routes + Addresses client.
// Docs: https://developers.samsara.com/reference/createroute
//
// All traffic goes through the shared throttled transport in hos.server.ts
// (4 req/s token bucket + 429 backoff), so dispatch pushes cannot get the org
// rate-limited out from under the Driver Time sweep.
//
// Contract notes that shape these signatures:
//  * POST /fleet/routes needs a name and >= 2 stops; each stop carries either
//    addressId or singleUseLocation. scheduledArrivalTime orders the stops —
//    the array order is ignored by Samsara.
//  * driverId XOR vehicleId (or neither). Never both.
//  * PATCH accepts sparse top-level fields, but `stops` OVERWRITES: a retained
//    stop must include its stop id. Building that payload is diff.ts's job.
//  * externalIds are supported on the route and on each stop, which is what
//    makes create-or-patch (never blind-create) possible.

import { SamsaraNotFoundError, samsaraApi, samsaraPaged } from "./hos.server";

export type SamsaraStopPayload = {
  id?: string;
  name?: string;
  addressId?: string;
  singleUseLocation?: {
    address?: string;
    name?: string;
    latitude?: number;
    longitude?: number;
    addressTypes?: string[];
  };
  scheduledArrivalTime?: string;
  scheduledDepartureTime?: string;
  notes?: string;
  externalIds?: Record<string, string>;
};

export type SamsaraRoutePayload = {
  name: string;
  stops: SamsaraStopPayload[];
  driverId?: string | null;
  vehicleId?: string | null;
  externalIds?: Record<string, string>;
  notes?: string;
};

export type SamsaraRouteRecord = {
  id: string;
  name?: string;
  driverId?: string | null;
  vehicleId?: string | null;
  externalIds?: Record<string, string>;
  stops?: Array<Record<string, any>>;
  [k: string]: unknown;
};

function assertSingleAssignment(payload: { driverId?: string | null; vehicleId?: string | null }) {
  if (payload.driverId && payload.vehicleId) {
    throw new Error("Samsara route accepts driverId XOR vehicleId, not both");
  }
}

/** externalId lookups use the `key:value` form Samsara expects in the path. */
export function externalIdPath(externalId: string): string {
  return `nelsonDispatch:${encodeURIComponent(externalId)}`;
}

export async function createRoute(payload: SamsaraRoutePayload): Promise<SamsaraRouteRecord> {
  assertSingleAssignment(payload);
  if (!payload.name) throw new Error("Samsara route requires a name");
  if (!Array.isArray(payload.stops) || payload.stops.length < 2) {
    throw new Error("Samsara route requires at least 2 stops");
  }
  const res = await samsaraApi<{ data?: SamsaraRouteRecord }>(`/fleet/routes`, {
    method: "POST",
    body: payload,
  });
  return (res?.data ?? (res as any)) as SamsaraRouteRecord;
}

/**
 * Sparse PATCH. `payload.stops`, when present, OVERWRITES the route's stops —
 * callers must pass a fully-formed stops array from diff.ts.
 */
export async function patchRoute(
  idOrExternalId: string,
  payload: Partial<SamsaraRoutePayload>,
): Promise<SamsaraRouteRecord> {
  assertSingleAssignment(payload);
  const res = await samsaraApi<{ data?: SamsaraRouteRecord }>(
    `/fleet/routes/${encodeURIComponent(idOrExternalId)}`,
    { method: "PATCH", body: payload },
  );
  return (res?.data ?? (res as any)) as SamsaraRouteRecord;
}

/** GET by our externalId. Returns null when Samsara has no such route. */
export async function getRouteByExternalId(externalId: string): Promise<SamsaraRouteRecord | null> {
  try {
    const res = await samsaraApi<{ data?: SamsaraRouteRecord }>(
      `/fleet/routes/${externalIdPath(externalId)}`,
    );
    const rec = (res?.data ?? (res as any)) as SamsaraRouteRecord | null;
    return rec && rec.id ? rec : null;
  } catch (e) {
    if (e instanceof SamsaraNotFoundError) return null;
    throw e;
  }
}

export async function deleteRoute(idOrExternalId: string): Promise<void> {
  await samsaraApi(`/fleet/routes/${encodeURIComponent(idOrExternalId)}`, { method: "DELETE" });
}

/** Route feed for a time window (used by reconciliation and, later, the board). */
export async function listRoutes(opts: { startMs: number; endMs: number }): Promise<SamsaraRouteRecord[]> {
  const params = new URLSearchParams({
    startTime: new Date(opts.startMs).toISOString(),
    endTime: new Date(opts.endMs).toISOString(),
    limit: "100",
  });
  return samsaraPaged<SamsaraRouteRecord>(`/fleet/routes?${params.toString()}`, (d) => d.data ?? []);
}

export type CreateAddressInput = {
  name: string;
  formattedAddress: string;
  latitude?: number | null;
  longitude?: number | null;
  radiusMeters?: number;
  externalIds?: Record<string, string>;
  notes?: string;
};

/**
 * Create a Samsara address. A circular geofence is attached when coordinates
 * are known (Samsara geocodes formattedAddress otherwise).
 */
export async function createAddress(input: CreateAddressInput): Promise<{ id: string; [k: string]: unknown }> {
  if (!input.name) throw new Error("Samsara address requires a name");
  if (!input.formattedAddress) throw new Error("Samsara address requires formattedAddress");
  const body: Record<string, unknown> = {
    name: input.name,
    formattedAddress: input.formattedAddress,
    addressTypes: ["customer"],
  };
  if (input.externalIds) body.externalIds = input.externalIds;
  if (input.notes) body.notes = input.notes;
  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    body.geofence = {
      circle: {
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: Math.max(30, Math.round(input.radiusMeters ?? 100)),
      },
    };
  }
  const res = await samsaraApi<{ data?: { id?: string } }>(`/addresses`, { method: "POST", body });
  const rec = (res?.data ?? (res as any)) as { id?: string };
  if (!rec?.id) throw new Error("Samsara address create returned no id");
  return rec as { id: string };
}
