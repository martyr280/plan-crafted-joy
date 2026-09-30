import { runDriverTimeSweep } from "../src/lib/driver-time.server";
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
const db = supabaseAdmin as any;
const weekStart = process.argv[2];
const end0 = new Date(Date.parse(weekStart) + 4 * 864e5).toISOString().slice(0, 10);
const { data: prev } = await db.from("driver_warehouse_events").select("driver_id,duration_min").is("superseded_at", null).gte("event_date", weekStart).lte("event_date", end0).limit(10000);
const before = new Map<string, number>();
for (const e of prev ?? []) before.set(e.driver_id, (before.get(e.driver_id) ?? 0) + e.duration_min);
const r: any = await runDriverTimeSweep({ weekStart, triggeredBy: null });
console.log(`run ${r.runId} ok=${r.ok ?? !r.error} scanned=${r.driversScanned} events=${r.eventsFound} ins=${r.inserted} upd=${r.updated} reopened=${r.reopened} ${r.error ?? ""}`);
const end = new Date(Date.parse(weekStart) + 4 * 864e5).toISOString().slice(0, 10);
const { data: ev } = await db.from("driver_warehouse_events").select("driver_id,driver_name,duration_min,location_source").is("superseded_at", null).gte("event_date", weekStart).lte("event_date", end).limit(10000);
const { data: ov } = await db.from("driver_time_week_overrides").select("driver_id,warehouse_actual").eq("week_start", weekStart);
console.log("Driver | Before | Nelson | Official | Diff | Moved");
for (const o of (ov ?? []).sort((a: any, b: any) => a.warehouse_actual.driverName.localeCompare(b.warehouse_actual.driverName))) {
  const mine = (ev ?? []).filter((e: any) => e.driver_id === o.driver_id);
  const n = mine.reduce((s: number, e: any) => s + e.duration_min, 0), off = o.warehouse_actual.minutes;
  const b0 = before.get(o.driver_id) ?? 0;
  console.log(`${o.warehouse_actual.driverName} | ${b0} | ${n} | ${off} | ${n - off > 0 ? "+" : ""}${n - off}${mine.some((e: any) => e.location_source === "remark") ? " (remark)" : ""} | ${n - b0 ? (n - b0 > 0 ? "+" : "") + (n - b0) : ""}`);
}
