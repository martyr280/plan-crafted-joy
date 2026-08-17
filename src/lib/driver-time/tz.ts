// Timezone helpers for the Driver Warehouse Time module.
// All date/week/time logic in this module is anchored to Central time (DST-aware).

export const CENTRAL_TZ = "America/Chicago";

/** YYYY-MM-DD of instant `d` as seen in `tz`. */
export function dateStrInTz(d: Date, tz: string = CENTRAL_TZ): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Real UTC offset in minutes for instant `d` in `tz` (e.g. -300 for CDT, -360 for CST). */
export function tzOffsetMinutesAt(d: Date, tz: string = CENTRAL_TZ): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  // Round to the nearest minute to absorb the dropped milliseconds.
  return Math.round((asUtc - d.getTime()) / 60000);
}
