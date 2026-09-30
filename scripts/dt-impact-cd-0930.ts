// READ-ONLY impact of candidate rules C and D, Sep 7–25. Reads refreshed hos_logs cache + live events. No writes.
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { fetchDrivers, fetchAddresses } from "../src/lib/samsara/hos.server";
import { filterRoster, getDriverTimeSettings } from "../src/lib/driver-time.server";
import { getHosSegments } from "../src/lib/samsara/cache.server";
import { localDateKey } from "../src/lib/driver-time/detect";
import { pointInGeofence } from "../src/lib/driver-time/geo";
import { tzOffsetMinutesAt } from "../src/lib/tz";
const db = supabaseAdmin as any, M = 60000;
const s = await getDriverTimeSettings();
const [drivers, addrs] = await Promise.all([fetchDrivers(), fetchAddresses()]);
const fences = addrs.filter((a) => s.warehouseAddressIds.includes(a.id)).map((a: any) => ({ id: a.id, name: a.name, hub: a.name, circle: a.circle, polygon: a.polygon }));
const { roster } = filterRoster(drivers, s);
const { segments } = await getHosSegments({ startMs: Date.parse("2026-09-07T05:00:00Z"), endMs: Date.parse("2026-09-26T04:59:59Z"), driverIds: roster.map((d) => d.id) });
const { data: live } = await db.from("driver_warehouse_events").select("driver_id,event_date,start_ts,end_ts,duration_min")
  .is("superseded_at", null).gte("event_date", "2026-09-07").lte("event_date", "2026-09-25").limit(10000);
const inFence = (x: any) => x.latitude != null && fences.some((f) => pointInGeofence({ latitude: x.latitude, longitude: x.longitude }, f as any));
const REST = new Set(["offDuty", "sleeperBerth", "personalConveyance"]);
const C: string[] = [], D: string[] = [];
for (const d of roster) {
  const off = tzOffsetMinutesAt(new Date("2026-09-15T12:00:00Z"), (d as any).timezone ?? "America/Chicago");
  const f = (ms: number) => new Date(ms + off * M).toISOString().slice(11, 16);
  const mine = segments.filter((x) => x.driverId === d.id).sort((a, b) => a.startMs - b.startMs);
  const evs = (live ?? []).filter((l: any) => l.driver_id === d.id);
  for (const e of evs) {
    const a = Date.parse(e.start_ts), b = Date.parse(e.end_ts);
    // C: first /clocked out/i remark inside the block ends it.
    const r = mine.find((x) => x.remark && /clocked out/i.test(x.remark) && x.startMs < b && x.endMs > a);
    if (r) { const cut = Math.max(a, r.startMs); const after = Math.round((cut - a) / M);
      C.push(`${e.event_date} | ${d.name} | ${e.duration_min} | ${after} | ${after - e.duration_min} | ${f(a)}–${f(b)} → ends ${f(cut)} | "${r.remark}" on ${r.status}`); }
  }
  // D: an in-fence onDuty arrival (own log location) followed only by rest/driving until an event starts later that day.
  for (let i = 0; i < mine.length; i++) {
    const arr = mine[i];
    if (arr.status !== "onDuty" || !inFence(arr)) continue;
    const date = localDateKey(arr.startMs, off);
    const next = evs.filter((l: any) => l.event_date === date && Date.parse(l.start_ts) > arr.startMs).sort((x: any, y: any) => x.start_ts < y.start_ts ? -1 : 1)[0];
    if (!next) continue;
    const T = Date.parse(next.start_ts);
    if (evs.some((l: any) => Date.parse(l.start_ts) <= arr.startMs && Date.parse(l.end_ts) >= arr.startMs)) continue;
    const between = mine.filter((x) => x.startMs >= arr.endMs && x.endMs <= T + 1000);
    if (!between.length || between.some((x) => !REST.has(x.status) && x.status !== "driving" && x.endMs - x.startMs > M)) continue;
    let add = (arr.endMs - arr.startMs);
    for (const x of between) if (REST.has(x.status) && inFence(x)) add += x.endMs - x.startMs;
    const addMin = Math.round(add / M);
    if (addMin < 1) continue;
    D.push(`${date} | ${d.name} | ${next.duration_min} | ${next.duration_min + addMin} | +${addMin} | arrival ${f(arr.startMs)}, block started ${f(T)}`);
    i = mine.indexOf(between[between.length - 1]);
  }
}
console.log("C date | driver | before | after | diff | block → new end | remark\n" + C.sort().join("\n"));
console.log("\nD date | driver | before | after | diff | detail\n" + D.sort().join("\n"));
