// Server-only Samsara HOS / drivers / addresses fetchers.
// Docs: https://developers.samsara.com/reference
//
// Samsara's published limit is 5 requests/second per org for most endpoints;
// we hold a token bucket at 4 req/s and back off on 429 so a weekly sweep of
// the whole roster can't get the org throttled.

const BASE = "https://api.samsara.com";

function token() {
  const t = process.env.SAMSARA_API_TOKEN;
  if (!t) throw new Error("SAMSARA_API_TOKEN is not configured");
  return t;
}

const MIN_INTERVAL_MS = 250; // 4 req/s
let lastCall = 0;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export class SamsaraScopeError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SamsaraScopeError";
  }
}

async function api<T = any>(path: string, attempt = 0): Promise<T> {
  await throttle();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token()}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    if (attempt >= 4) throw new Error(`Samsara rate limited on ${path} after ${attempt} retries`);
    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    return api<T>(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = `Samsara ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new SamsaraScopeError(path, res.status, msg);
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

async function paged<T = any>(path: string, pick: (d: any) => any[]): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  let guard = 0;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${after ? `${sep}after=${encodeURIComponent(after)}` : ""}`;
    const data: any = await api(url);
    out.push(...(pick(data) as T[]));
    after = data?.pagination?.hasNextPage ? data.pagination.endCursor ?? null : null;
  } while (after && ++guard < 200);
  return out;
}

/* ----------------------------------------------------------------- drivers */

export type SamsaraDriver = {
  id: string;
  name: string;
  driverActivationStatus: string | null;
  eldDayStartHour: number | null;
  timezone: string | null;
  tags: string[];
};

/** Full roster, including deactivated drivers (they still have logs in history). */
export async function fetchDrivers(): Promise<SamsaraDriver[]> {
  const rows = await paged<any>(`/fleet/drivers?limit=100&driverActivationStatus=active`, (d) => d.data ?? []);
  let deactivated: any[] = [];
  try {
    deactivated = await paged<any>(`/fleet/drivers?limit=100&driverActivationStatus=deactivated`, (d) => d.data ?? []);
  } catch {
    deactivated = [];
  }
  const seen = new Set<string>();
  return [...rows, ...deactivated]
    .map((d) => ({
      id: String(d.id),
      name: d.name ?? String(d.id),
      driverActivationStatus: d.driverActivationStatus ?? null,
      eldDayStartHour: typeof d.eldDayStartHour === "number" ? d.eldDayStartHour : null,
      timezone: d.timezone ?? d.tachographCardNumber ?? null,
      tags: (d.tags ?? []).map((t: any) => t?.name).filter(Boolean),
    }))
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

/* --------------------------------------------------------------- addresses */

export type SamsaraAddress = {
  id: string;
  name: string;
  formattedAddress: string | null;
  tags: string[];
  circle: { latitude: number; longitude: number; radiusMeters: number } | null;
  polygon: Array<{ latitude: number; longitude: number }> | null;
};

/** Addresses (geofences) configured in Samsara. */
export async function fetchAddresses(): Promise<SamsaraAddress[]> {
  const rows = await paged<any>(`/addresses?limit=100`, (d) => d.data ?? []);
  return rows.map((a) => {
    const g = a.geofence ?? {};
    return {
      id: String(a.id),
      name: a.name ?? String(a.id),
      formattedAddress: a.formattedAddress ?? null,
      tags: (a.tags ?? []).map((t: any) => t?.name).filter(Boolean),
      circle: g.circle
        ? {
            latitude: Number(g.circle.latitude),
            longitude: Number(g.circle.longitude),
            radiusMeters: Number(g.circle.radiusMeters ?? 0),
          }
        : null,
      polygon: Array.isArray(g.polygon?.vertices)
        ? g.polygon.vertices.map((v: any) => ({ latitude: Number(v.latitude), longitude: Number(v.longitude) }))
        : null,
    };
  });
}

/* -------------------------------------------------------------- HOS logs */

export type NormalizedHosSegment = {
  driverId: string;
  driverName: string | null;
  status: string;
  startMs: number;
  endMs: number;
  latitude: number | null;
  longitude: number | null;
  vehicleId: string | null;
};

function coordOf(entry: any): { latitude: number | null; longitude: number | null } {
  const loc = entry?.location ?? entry?.startLocation ?? null;
  const lat = loc?.latitude ?? entry?.latitude ?? null;
  const lon = loc?.longitude ?? entry?.longitude ?? null;
  return {
    latitude: typeof lat === "number" ? lat : null,
    longitude: typeof lon === "number" ? lon : null,
  };
}

/**
 * HOS duty logs for the given drivers, normalized into closed segments.
 * Samsara returns log *starts*; the end is the next log's start (or the window
 * end for the final open log).
 */
export async function fetchHosLogs(opts: {
  startMs: number;
  endMs: number;
  driverIds: string[];
  batchSize?: number;
}): Promise<NormalizedHosSegment[]> {
  const clampedEnd = Math.min(opts.endMs, Date.now());
  if (opts.startMs >= clampedEnd) return [];
  const startTime = new Date(opts.startMs).toISOString();
  const endTime = new Date(clampedEnd).toISOString();
  const batchSize = opts.batchSize ?? 25;
  const out: NormalizedHosSegment[] = [];

  for (let i = 0; i < opts.driverIds.length; i += batchSize) {
    const batch = opts.driverIds.slice(i, i + batchSize);
    const params = new URLSearchParams({ startTime, endTime, driverIds: batch.join(",") });
    const rows = await paged<any>(`/fleet/hos/logs?${params.toString()}`, (d) => d.data ?? []);
    for (const row of rows) {
      const driverId = String(row.driver?.id ?? row.driverId ?? "");
      const driverName = row.driver?.name ?? null;
      const logs = [...(row.logs ?? [])].sort(
        (a: any, b: any) => Date.parse(a.logStartTime ?? 0) - Date.parse(b.logStartTime ?? 0),
      );
      for (let k = 0; k < logs.length; k++) {
        const entry = logs[k];
        const s = Date.parse(entry.logStartTime ?? "");
        if (!Number.isFinite(s)) continue;
        const nextStart = k + 1 < logs.length ? Date.parse(logs[k + 1].logStartTime ?? "") : NaN;
        const e = Number.isFinite(nextStart) ? nextStart : Math.min(opts.endMs, Date.now());
        if (!(e > s)) continue;
        const { latitude, longitude } = coordOf(entry);
        out.push({
          driverId,
          driverName,
          status: String(entry.hosStatusType ?? entry.status ?? "unknown"),
          startMs: s,
          endMs: e,
          latitude,
          longitude,
          vehicleId: entry.vehicle?.id ? String(entry.vehicle.id) : null,
        });
      }
    }
  }
  return out;
}

/** Historical GPS samples used as a location fallback. Best-effort. */
export async function fetchVehicleGpsHistory(opts: {
  startMs: number;
  endMs: number;
  vehicleIds: string[];
  stepMs?: number;
}): Promise<Array<{ vehicleId: string; timeMs: number; latitude: number; longitude: number }>> {
  if (!opts.vehicleIds.length) return [];
  const clampedEnd = Math.min(opts.endMs, Date.now());
  if (opts.startMs >= clampedEnd) return [];
  const out: Array<{ vehicleId: string; timeMs: number; latitude: number; longitude: number }> = [];
  for (let i = 0; i < opts.vehicleIds.length; i += 20) {
    const ids = opts.vehicleIds.slice(i, i + 20);
    const params = new URLSearchParams({
      startTime: new Date(opts.startMs).toISOString(),
      endTime: new Date(clampedEnd).toISOString(),
      types: "gps",
      ids: ids.join(","),
    });
    const rows = await paged<any>(`/fleet/vehicles/stats/history?${params.toString()}`, (d) => d.data ?? []);
    for (const v of rows) {
      for (const g of v.gps ?? []) {
        const t = Date.parse(g.time ?? "");
        if (!Number.isFinite(t)) continue;
        if (typeof g.latitude !== "number" || typeof g.longitude !== "number") continue;
        out.push({ vehicleId: String(v.id), timeMs: t, latitude: g.latitude, longitude: g.longitude });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ scope probes */

export type ScopeProbe = { endpoint: string; ok: boolean; detail: string };

/** Probe each endpoint the Driver Time module needs and name what's missing. */
export async function probeSamsaraScopes(): Promise<ScopeProbe[]> {
  const probes: Array<{ endpoint: string; run: () => Promise<string> }> = [
    {
      endpoint: "Vehicles",
      run: async () => {
        const d = await api<{ data?: any[] }>(`/fleet/vehicles?limit=1`);
        return `${d.data?.length ?? 0} vehicle(s) visible`;
      },
    },
    {
      endpoint: "Drivers",
      run: async () => {
        const d = await api<{ data?: any[] }>(`/fleet/drivers?limit=1`);
        return `${d.data?.length ?? 0} driver(s) visible`;
      },
    },
    {
      endpoint: "Addresses (geofences)",
      run: async () => {
        const d = await api<{ data?: any[] }>(`/addresses?limit=1`);
        return `${d.data?.length ?? 0} address(es) visible`;
      },
    },
    {
      endpoint: "HOS logs",
      run: async () => {
        const end = new Date();
        const start = new Date(end.getTime() - 24 * 3600_000);
        const params = new URLSearchParams({
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        });
        const d = await api<{ data?: any[] }>(`/fleet/hos/logs?${params.toString()}`);
        return `${d.data?.length ?? 0} driver log group(s) in the last 24h`;
      },
    },
  ];

  const out: ScopeProbe[] = [];
  for (const p of probes) {
    try {
      out.push({ endpoint: p.endpoint, ok: true, detail: await p.run() });
    } catch (e: any) {
      const scope = e instanceof SamsaraScopeError;
      out.push({
        endpoint: p.endpoint,
        ok: false,
        detail: scope
          ? `Not permitted (${e.status}) — grant this scope to the Samsara API token`
          : e?.message ?? "Unknown error",
      });
    }
  }
  return out;
}

/* -------------------------------------------------- raw status vocabulary */

/**
 * Diagnostics helper: tally the RAW `hosStatusType` strings Samsara sends,
 * with no normalization, so we can see the exact casing/spelling.
 */
export async function fetchRawHosStatusCounts(opts: {
  startMs: number;
  endMs: number;
  driverIds: string[];
  batchSize?: number;
}): Promise<Array<{ status: string; segments: number }>> {
  const clampedEnd = Math.min(opts.endMs, Date.now());
  if (opts.startMs >= clampedEnd) return [];
  const startTime = new Date(opts.startMs).toISOString();
  const endTime = new Date(clampedEnd).toISOString();
  const batchSize = opts.batchSize ?? 25;
  const tally = new Map<string, number>();

  for (let i = 0; i < opts.driverIds.length; i += batchSize) {
    const batch = opts.driverIds.slice(i, i + batchSize);
    const params = new URLSearchParams({ startTime, endTime, driverIds: batch.join(",") });
    const rows = await paged<any>(`/fleet/hos/logs?${params.toString()}`, (d) => d.data ?? []);
    for (const row of rows) {
      for (const entry of row.logs ?? []) {
        const status = String(entry.hosStatusType ?? entry.status ?? "unknown");
        tally.set(status, (tally.get(status) ?? 0) + 1);
      }
    }
  }
  return Array.from(tally.entries())
    .map(([status, segments]) => ({ status, segments }))
    .sort((a, b) => b.segments - a.segments);
}
