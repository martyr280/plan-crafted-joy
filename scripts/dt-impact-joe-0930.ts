// READ-ONLY impact of rules A (remark) and B (work-stop tail) over Sep 7–25.
// Fresh Samsara HOS reads (no cache writes) + live driver_warehouse_events reads. No DB writes.
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { fetchDrivers, fetchHosLogs, fetchAddresses } from "../src/lib/samsara/hos.server";
import { filterRoster, getDriverTimeSettings } from "../src/lib/driver-time.server";
import { detectWarehouseEvents, localDateKey } from "../src/lib/driver-time/detect";
import { tzOffsetMinutesAt } from "../src/lib/tz";
const db = supabaseAdmin as any, M = 60000;
const settings = await getDriverTimeSettings();
const [drivers, addrs] = await Promise.all([fetchDrivers(), fetchAddresses()]);
const fences = addrs.filter((a) => settings.warehouseAddressIds.includes(a.id)).map((a) => ({ id: a.id, name: a.name, hub: a.name, circle: a.circle, polygon: a.polygon }));
const { roster } = filterRoster(drivers, settings);
const segs: any[] = [];
for (let d = Date.parse("2026-09-07T04:00:00Z"); d < Date.parse("2026-09-26T06:00:00Z"); d += 86400000)
  segs.push(...(await fetchHosLogs({ startMs: d, endMs: d + 86400000, driverIds: roster.map((r) => r.id) })));
const { data: live } = await db.from("driver_warehouse_events").select("driver_id,event_date,start_ts,end_ts,duration_min")
  .is("superseded_at", null).gte("event_date", "2026-09-07").lte("event_date", "2026-09-25").limit(10000);
const tzOf = (d: any) => tzOffsetMinutesAt(new Date("2026-09-15T12:00:00Z"), d.timezone ?? "America/Chicago");
const fmt = (ms: number, off: number) => new Date(ms + off * M).toISOString().slice(11, 16);
const remarkKeys = new Set<string>(), A: string[] = [], B: string[] = [], remarks: Record<string, Set<string>> = {};
for (const d of roster) {
  const off = tzOf(d);
  const mine = segs.filter((s) => s.driverId === d.id).sort((a, b) => a.startMs - b.startMs);
  for (const s of mine) if (s.remark) (remarks[s.remark.toLowerCase()] ??= new Set()).add(d.name);
  const ev = detectWarehouseEvents({ driver: { id: d.id, name: d.name }, segments: mine, warehouses: fences as any, gpsSamples: [],
    options: { tzOffsetMinutes: off, basis: settings.basis, hubTags: d.tags, thresholdMinutes: settings.thresholdMinutes, mergeGapMinutes: settings.mergeGapMinutes } })
    .filter((e) => e.locationSource === "remark" && e.eventDate >= "2026-09-07" && e.eventDate <= "2026-09-25");
  for (const e of ev) {
    const before = (live ?? []).filter((l: any) => l.driver_id === d.id && l.event_date === e.eventDate).reduce((n: number, l: any) => n + l.duration_min, 0);
    remarkKeys.add(`${d.id}|${e.eventDate}`);
    A.push(`${e.eventDate} | ${d.name} | ${before} | ${e.durationMin} | ${e.durationMin - before} | ${fmt(e.startMs, off)}–${fmt(e.endMs, off)} | ${e.notes}`);
  }
  // B on the day's last live event.
  const byDate = new Map<string, any>();
  for (const l of (live ?? []).filter((l: any) => l.driver_id === d.id)) if (!byDate.get(l.event_date) || l.end_ts > byDate.get(l.event_date).end_ts) byDate.set(l.event_date, l);
  for (const [date, l] of byDate) {
    if (remarkKeys.has(`${d.id}|${date}`)) continue;
    const end = Date.parse(l.end_ts);
    const after = mine.filter((s) => s.startMs >= end - 1000 && localDateKey(s.startMs, off) === date && s.endMs - s.startMs >= 60000);
    let i = 0; while (i < after.length && after[i].status === "driving" && after[i].endMs - after[i].startMs <= 30 * M) i++;
    const stop = after[i];
    if (!stop || i === 0 || !["onDuty", "yardMove"].includes(stop.status) || stop.startMs - end > 30 * M) continue;
    let j = i; while (j + 1 < after.length && ["onDuty", "yardMove"].includes(after[j + 1].status)) j++;
    const nxt = after[j + 1];
    const closes = !nxt || ["offDuty", "sleeperBerth"].includes(nxt.status) || (nxt.status === "driving" && nxt.endMs - nxt.startMs > 30 * M);
    if (after[j].endMs - stop.startMs > 30 * M || !closes) continue;
    const add = Math.round((after[j].endMs - end) / M);
    B.push(`${date} | ${d.name} | ${l.duration_min} | ${l.duration_min + add} | +${add} | ${fmt(end, off)}–${fmt(after[j].endMs, off)}`);
  }
}
console.log("REMARK TEXTS:", Object.entries(remarks).map(([k, v]) => `${k} (${v.size} drivers)`).join("; "));
console.log("\nA date | driver | before | after | diff | window | remark\n" + A.sort().join("\n"));
console.log("\nB date | driver | last-event before | after | diff | tail\n" + B.sort().join("\n"));
