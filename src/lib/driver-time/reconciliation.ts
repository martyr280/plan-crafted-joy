import { z } from "zod";

export const actualSchema = z.object({
  driverName: z.string().trim().min(1).max(120),
  hub: z.enum(["Birmingham", "Dallas", "Ocala"]),
  minutes: z.number().int().min(0).max(7200),
  scope: z.literal("weekdays"),
  source: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(1).max(2000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  intervals: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    minutes: z.number().int().positive().max(1440),
    note: z.string().max(2000).optional(),
  })).max(100).optional(),
});
export type WarehouseActual = z.infer<typeof actualSchema>;

export function parseHoursMinutes(text: string): number {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim());
  if (!m) throw new Error("Enter hours:minutes, for example 5:30. Decimal hours are not accepted here.");
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes > 7200) throw new Error("Warehouse time cannot exceed 120 hours for five days.");
  return minutes;
}
export function formatMinutes(minutes: number): string {
  const n = Math.round(Math.abs(minutes));
  return `${minutes < 0 ? "−" : ""}${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
export function hubTimezone(hub?: string | null): string {
  return hub === "Ocala" ? "America/New_York" : "America/Chicago";
}
export function weekday(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
}
export function validateActual(actual: WarehouseActual, weekStart: string): WarehouseActual {
  const a = actualSchema.parse(actual);
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0,10) !== weekStart || new Date(start).getUTCDay() !== 1)
    throw new Error("Choose a valid Monday for the report week.");
  if (a.intervals) {
    let sum = 0;
    const sorted = [...a.intervals].sort((x,y) => Date.parse(x.start)-Date.parse(y.start));
    let lastEnd = -Infinity;
    for (const i of sorted) {
      const d = Date.parse(`${i.date}T00:00:00Z`);
      const s = Date.parse(i.start), e = Date.parse(i.end);
      const localCalendar = new Intl.DateTimeFormat("en-CA", {timeZone:hubTimezone(a.hub),year:"numeric",month:"2-digit",day:"2-digit"});
      const localDate = localCalendar.format(new Date(s));
      const lastLocalDate = localCalendar.format(new Date(e - 1));
      if (!Number.isFinite(d) || d < start || d >= start + 5*86400000 || localDate !== i.date ||
          !weekday(lastLocalDate) || Date.parse(`${lastLocalDate}T00:00:00Z`) >= start + 5*86400000 ||
          s < lastEnd || e <= s || (e-s)/60000 !== i.minutes)
        throw new Error("Official intervals must be non-overlapping, inside the selected weekdays, and match their minutes.");
      lastEnd = e;
      sum += i.minutes;
    }
    if (sum !== a.minutes) throw new Error("Official intervals do not add up to the total.");
  }
  return a;
}

/** Normalize whitespace/case only. Driver IDs, not fuzzy names, join actuals. */
export function driverNameKey(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ").replace(/\*+$/, "");
  return key;
}

export function buildReconciledDrivers(events: any[], overrides: any[], includeWeekends = false): any[] {
  const buckets = new Map<string, any>();
  const records = overrides.filter(o => o.warehouse_actual != null);
  for (const o of records) {
    const a = actualSchema.parse(o.warehouse_actual);
    buckets.set(String(o.driver_id), { driverId:String(o.driver_id), driverName:a.driverName,
      events:[], flaggedMinutes:0, automatedMinutes:0, detectedMinutes:0, weekendMinutes:0,
      unresolvedMinutes:0, excludedMinutes:0, minutesByHub:{}, official:a,
      revision:o.updated_at, history:o.warehouse_actual_history ?? [], officialMinutes:a.minutes, hub:a.hub });
  }
  for (const ev of events) {
    if (!includeWeekends && !weekday(ev.event_date)) continue;
    // Historical report-only identities are explicit; join on a unique exact
    // normalized name until an operator maps the Samsara ID. Never use fuzzy IDs.
    const exact = records.filter(o => String(o.driver_id).startsWith("report:") &&
      o.warehouse_actual.hub === ev.hub &&
      driverNameKey(o.warehouse_actual.driverName) === driverNameKey(ev.driver_name ?? ""));
    const key = buckets.has(String(ev.driver_id)) ? String(ev.driver_id)
      : exact.length === 1 ? String(exact[0].driver_id) : String(ev.driver_id);
    const b = buckets.get(key) ?? {driverId:key,driverName:ev.driver_name ?? key,events:[],flaggedMinutes:0,
      automatedMinutes:0,detectedMinutes:0,weekendMinutes:0,unresolvedMinutes:0,excludedMinutes:0,minutesByHub:{},
      official:null,officialMinutes:null,revision:null,history:[]};
    b.events.push(ev);
    const min = Number(ev.duration_min ?? 0);
    if (ev.superseded_at || ev.status === "excused") { b.excludedMinutes += min; }
    else if (ev.needs_review || ev.location_source === "unknown" || !ev.hub) { b.unresolvedMinutes += min; }
    else {
      if (weekday(ev.event_date)) b.automatedMinutes += min;
      else b.weekendMinutes += min;
      const hub = ev.hub;
      b.minutesByHub[hub] = (b.minutesByHub[hub] ?? 0) + min;
    }
    if (!ev.superseded_at && weekday(ev.event_date)) b.detectedMinutes += min;
    buckets.set(key,b);
  }
  return Array.from(buckets.values()).map(b => {
    b.revision ??= overrides.find(o=>String(o.driver_id)===b.driverId)?.updated_at ?? null;
    b.flaggedMinutes = (b.officialMinutes ?? b.automatedMinutes) + b.weekendMinutes;
    b.varianceMinutes = b.official ? b.automatedMinutes - b.officialMinutes : null;
    b.hub = b.official?.hub ?? Object.entries(b.minutesByHub).sort((a:any,b:any)=>b[1]-a[1])[0]?.[0] ?? b.events.find((e:any)=>e.hub)?.hub ?? "Unassigned warehouse";
    b.multiHub = Object.keys(b.minutesByHub).length > 1;
    return b;
  }).sort((a,b)=>b.flaggedMinutes-a.flaggedMinutes || a.driverName.localeCompare(b.driverName));
}

export function reconciliationCsv(drivers: any[]): string {
  const rows = [["Driver","Warehouse","Official weekday minutes","Automated weekday minutes","Variance minutes (automated minus official)","Reported minutes","Reported H:MM","Source"]];
  for (const d of drivers) rows.push([d.driverName,d.hub,d.officialMinutes ?? "",d.automatedMinutes,
    d.varianceMinutes ?? "",d.flaggedMinutes,formatMinutes(d.flaggedMinutes),d.official?.source ?? "Automated estimate"] as any);
  return rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
}
