// Server-only Samsara API wrapper. Do NOT import from client code.
// Docs: https://developers.samsara.com/reference

const BASE = "https://api.samsara.com";

function token() {
  const t = process.env.SAMSARA_API_TOKEN;
  if (!t) throw new Error("SAMSARA_API_TOKEN is not configured");
  return t;
}

async function samsaraFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Samsara ${res.status} ${res.statusText} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// Vehicle fleet locations (live). Uses the Fleet Stats endpoint.
export async function fetchVehicleLocations() {
  const data = await samsaraFetch<{ data: any[] }>(`/fleet/vehicles/stats?types=gps`);
  return (data.data ?? []).map((v) => ({
    id: String(v.id),
    name: v.name ?? v.id,
    latitude: v.gps?.latitude ?? null,
    longitude: v.gps?.longitude ?? null,
    speedMph: v.gps?.speedMilesPerHour ?? null,
    headingDeg: v.gps?.headingDegrees ?? null,
    reverseGeo: v.gps?.reverseGeo?.formattedLocation ?? null,
    time: v.gps?.time ?? null,
  }));
}

// Active trips for a vehicle (or all vehicles in a window).
export async function fetchTrips(opts: { startMs: number; endMs: number; vehicleIds?: string[] }) {
  const params = new URLSearchParams({
    startMs: String(opts.startMs),
    endMs: String(opts.endMs),
  });
  if (opts.vehicleIds?.length) params.set("vehicleIds", opts.vehicleIds.join(","));
  const data = await samsaraFetch<{ data: any[] }>(`/fleet/trips?${params.toString()}`);
  return data.data ?? [];
}

// Safety events.
export async function fetchSafetyEvents(opts: { startMs: number; endMs: number }) {
  const params = new URLSearchParams({
    startTime: new Date(opts.startMs).toISOString(),
    endTime: new Date(opts.endMs).toISOString(),
  });
  const data = await samsaraFetch<{ data: any[] }>(`/fleet/safety-events?${params.toString()}`);
  return data.data ?? [];
}

// DVIRs (driver vehicle inspection reports).
export async function fetchDvirs(opts: { startMs: number; endMs: number }) {
  const params = new URLSearchParams({
    startTime: new Date(opts.startMs).toISOString(),
    endTime: new Date(opts.endMs).toISOString(),
  });
  const data = await samsaraFetch<{ data: any[] }>(`/fleet/dvirs?${params.toString()}`);
  return data.data ?? [];
}

// Documents (BOL / POD captured by drivers).
export async function fetchDocuments(opts: { startMs: number; endMs: number }) {
  const params = new URLSearchParams({
    startTime: new Date(opts.startMs).toISOString(),
    endTime: new Date(opts.endMs).toISOString(),
  });
  const data = await samsaraFetch<{ data: any[] }>(`/fleet/documents?${params.toString()}`);
  return data.data ?? [];
}

export async function fetchDocumentById(id: string) {
  const data = await samsaraFetch<{ data: any }>(`/fleet/documents/${encodeURIComponent(id)}`);
  return data.data;
}

// Health check used by Settings → Integrations.
export async function samsaraHealthCheck(): Promise<{ ok: boolean; message: string; orgName?: string }> {
  try {
    const data = await samsaraFetch<{ data: any[] }>(`/fleet/vehicles?limit=1`);
    return { ok: true, message: `Connected. ${data.data?.length ?? 0} vehicle(s) accessible.` };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? "Unknown error" };
  }
}
