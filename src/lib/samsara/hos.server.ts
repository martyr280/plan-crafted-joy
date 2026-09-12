// Server-only Samsara HOS / drivers / addresses fetchers.
// Docs: https://developers.samsara.com/reference
//
// Samsara's published limit is 5 requests/second per org for most endpoints;
// we hold a token bucket at 4 req/s and back off on 429 so a weekly sweep of
// the whole roster can't get the org throttled.

import { usableCoordinates } from "@/lib/driver-time/geo";
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

/** Thrown on GET 404 so create-or-patch can treat "absent" as a normal branch. */
export class SamsaraNotFoundError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "SamsaraNotFoundError";
  }
}


async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  attempt = 0,
): Promise<T> {
  await throttle();
  const method = init.method ?? "GET";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 429) {
    if (attempt >= 4) throw new Error(`Samsara rate limited on ${path} after ${attempt} retries`);
    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
    return api<T>(path, init, attempt + 1);
  }
  if (res.status === 404 && method === "GET") {
    throw new SamsaraNotFoundError(path, `Samsara 404 on ${path}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = `Samsara ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new SamsaraScopeError(path, res.status, msg);
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
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
  if (after) throw new Error("Samsara pagination limit reached; results are incomplete");
  return out;
}

/** Shared, throttled Samsara transport for other server modules (routes, addresses). */
export const samsaraApi = api;
export const samsaraPaged = paged;


/* ----------------------------------------------------------------- drivers */

export type SamsaraDriver = {
  id: string;
  name: string;
  driverActivationStatus: string | null;
  eldDayStartHour: number | null;
  timezone: string | null;
  tags: string[];
  /** Real NDI drivers hold a licence; shared warehouse/LTL logins do not. */
  licenseNumber: string | null;
  licenseState: string | null;
  username: string | null;
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
      timezone: d.timezone ?? null,
      tags: (d.tags ?? []).map((t: any) => t?.name).filter(Boolean),
      // Present on the list objects; no extra per-driver call is made.
      licenseNumber: d.licenseNumber ? String(d.licenseNumber) : null,
      licenseState: d.licenseState ? String(d.licenseState) : null,
      username: d.username ? String(d.username) : null,
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
  const loc = entry?.logRecordedLocation ?? entry?.location ?? entry?.startLocation ?? null;
  const lat = loc?.latitude ?? entry?.latitude ?? null;
  const lon = loc?.longitude ?? entry?.longitude ?? null;
  if (!usableCoordinates(lat, lon)) return { latitude: null, longitude: null };
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
    // A driver's logs can span response pages. Normalize after joining them,
    // otherwise the last open log on every page extends to the query end.
    const grouped = new Map<string, any>();
    for (const row of rows) {
      const id = String(row.driver?.id ?? row.driverId ?? "");
      if (!id || !batch.includes(id)) continue;
      const prior = grouped.get(id) ?? { ...row, hosLogs: [] };
      prior.hosLogs.push(...(row.hosLogs ?? row.logs ?? []));
      grouped.set(id, prior);
    }
    for (const row of grouped.values()) {
      const driverId = String(row.driver?.id ?? row.driverId ?? "");
      const driverName = row.driver?.name ?? null;
      // Samsara's response field is `hosLogs`; `logs` is kept only as a fallback.
      const logs = Array.from(new Map((row.hosLogs as any[]).map((log: any) =>
        [log.id ?? `${log.logStartTime}|${log.hosStatusType ?? log.status}`, log])).values()).sort(
        (a: any, b: any) => Date.parse(a.logStartTime ?? 0) - Date.parse(b.logStartTime ?? 0),
      );
      for (let k = 0; k < logs.length; k++) {
        const entry = logs[k];
        const s = Date.parse(entry.logStartTime ?? "");
        if (!Number.isFinite(s)) continue;
        const ownEnd = Date.parse(entry.logEndTime ?? "");
        const nextStart = k + 1 < logs.length ? Date.parse(logs[k + 1].logStartTime ?? "") : NaN;
        const e = Number.isFinite(ownEnd)
          ? ownEnd
          : Number.isFinite(nextStart)
            ? nextStart
            : Math.min(opts.endMs, Date.now());
        const start = Math.max(s, opts.startMs);
        const end = Math.min(e, Number.isFinite(nextStart) ? nextStart : clampedEnd, clampedEnd);
        if (!(end > start)) continue;

        const { latitude, longitude } = coordOf(entry);
        out.push({
          driverId,
          driverName,
          status: String(entry.hosStatusType ?? entry.status ?? "unknown"),
          startMs: start,
          endMs: end,
          latitude,
          longitude,
          vehicleId: entry.vehicle?.id ? String(entry.vehicle.id) : entry.vehicleId ? String(entry.vehicleId) : null,
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
        if (!usableCoordinates(g.latitude, g.longitude)) continue;
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
        const groups = d.data ?? [];
        const entries = groups.reduce((n, g: any) => n + (g.hosLogs ?? g.logs ?? []).length, 0);
        return `${groups.length} driver log group(s), ${entries} log entr(ies) in the last 24h`;
      },

    },
    {
      endpoint: "Routes (read)",
      run: async () => {
        const end = new Date();
        const start = new Date(end.getTime() - 24 * 3600_000);
        const params = new URLSearchParams({
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        });
        const d = await api<{ data?: any[] }>(`/fleet/routes?${params.toString()}&limit=1`);
        return `${d.data?.length ?? 0} route(s) visible in the last 24h`;
      },
    },
    {
      endpoint: "Routes (write)",
      run: async () => {
        // Write-scope probe without side effects: a deliberately invalid body.
        // 400 proves the token may write; 401/403 proves it may not.
        try {
          await api(`/fleet/routes`, { method: "POST", body: {} });
          return "Write accepted (unexpected — no route was intended)";
        } catch (e: any) {
          if (e instanceof SamsaraScopeError) throw e;
          return "Write scope present (validation rejected the probe body, as expected)";
        }
      },
    },
    {
      endpoint: "Addresses (write)",
      run: async () => {
        try {
          await api(`/addresses`, { method: "POST", body: {} });
          return "Write accepted (unexpected — no address was intended)";
        } catch (e: any) {
          if (e instanceof SamsaraScopeError) throw e;
          return "Write scope present (validation rejected the probe body, as expected)";
        }
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

/* ------------------------------------------------- daily logs & assignments */

export type SamsaraDailyLog = {
  driverId: string;
  driverName: string | null;
  /** Driver-local ELD day, YYYY-MM-DD when Samsara supplies it. */
  logDate: string | null;
  startMs: number | null;
  endMs: number | null;
  raw: any;
};

/**
 * HOS daily logs (per driver, per ELD day): the certified duty totals Samsara
 * itself reports. Used as corroborating evidence, not as segment geometry.
 */
export async function fetchDailyLogs(opts: {
  startMs: number;
  endMs: number;
  driverIds: string[];
  batchSize?: number;
}): Promise<SamsaraDailyLog[]> {
  const clampedEnd = Math.min(opts.endMs, Date.now());
  if (opts.startMs >= clampedEnd || !opts.driverIds.length) return [];
  const startDate = new Date(opts.startMs).toISOString().slice(0, 10);
  const endDate = new Date(clampedEnd).toISOString().slice(0, 10);
  const batchSize = opts.batchSize ?? 25;
  const out: SamsaraDailyLog[] = [];

  for (let i = 0; i < opts.driverIds.length; i += batchSize) {
    const batch = opts.driverIds.slice(i, i + batchSize);
    const params = new URLSearchParams({ startDate, endDate, driverIds: batch.join(",") });
    const rows = await paged<any>(`/fleet/hos/daily-logs?${params.toString()}`, (d) => d.data ?? []);
    for (const row of rows) {
      const driverId = String(row.driver?.id ?? row.driverId ?? "");
      if (!driverId) continue;
      const days = Array.isArray(row.dailyLogs) ? row.dailyLogs : Array.isArray(row.days) ? row.days : [row];
      for (const day of days) {
        const start = Date.parse(day.startTime ?? day.logStartTime ?? "");
        const end = Date.parse(day.endTime ?? day.logEndTime ?? "");
        out.push({
          driverId,
          driverName: row.driver?.name ?? null,
          logDate: day.logDate ?? day.date ?? (Number.isFinite(start) ? new Date(start).toISOString().slice(0, 10) : null),
          startMs: Number.isFinite(start) ? start : null,
          endMs: Number.isFinite(end) ? end : null,
          raw: day,
        });
      }
    }
  }
  return out;
}

export type SamsaraAssignment = {
  driverId: string;
  driverName: string | null;
  vehicleId: string;
  vehicleName: string | null;
  startMs: number;
  endMs: number | null;
  assignmentType: string | null;
};

/** Driver-to-vehicle assignments, so a segment with no vehicle can still be located. */
export async function fetchDriverVehicleAssignments(opts: {
  startMs: number;
  endMs: number;
  driverIds: string[];
  batchSize?: number;
}): Promise<SamsaraAssignment[]> {
  const clampedEnd = Math.min(opts.endMs, Date.now());
  if (opts.startMs >= clampedEnd || !opts.driverIds.length) return [];
  const startTime = new Date(opts.startMs).toISOString();
  const endTime = new Date(clampedEnd).toISOString();
  const batchSize = opts.batchSize ?? 25;
  const out: SamsaraAssignment[] = [];

  for (let i = 0; i < opts.driverIds.length; i += batchSize) {
    const batch = opts.driverIds.slice(i, i + batchSize);
    // filterBy is mandatory on this endpoint; without it Samsara answers 400
    // and the whole dataset silently comes back empty.
    const params = new URLSearchParams({
      startTime,
      endTime,
      filterBy: "drivers",
      driverIds: batch.join(","),
    });
    const rows = await paged<any>(`/fleet/driver-vehicle-assignments?${params.toString()}`, (d) => d.data ?? []);
    for (const row of rows) {
      const driverId = String(row.driver?.id ?? row.driverId ?? row.id ?? "");
      const list = Array.isArray(row.assignments) ? row.assignments : [row];
      for (const a of list) {
        const vehicleId = String(a.vehicle?.id ?? a.vehicleId ?? "");
        const start = Date.parse(a.startTime ?? a.assignedAtTime ?? "");
        if (!driverId || !vehicleId || !Number.isFinite(start)) continue;
        const end = Date.parse(a.endTime ?? "");
        out.push({
          driverId,
          driverName: row.driver?.name ?? a.driver?.name ?? null,
          vehicleId,
          vehicleName: a.vehicle?.name ?? null,
          startMs: start,
          endMs: Number.isFinite(end) ? end : null,
          assignmentType: a.assignmentType ?? null,
        });
      }
    }
  }
  return out;
}
