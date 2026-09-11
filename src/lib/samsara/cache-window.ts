// Pure helpers for the Samsara cache layer. No network, no database.

import { CENTRAL_TZ, dateStrInTz, tzOffsetMinutesAt } from "@/lib/tz";

export type CacheDay = {
  /** Central calendar date, YYYY-MM-DD. */
  date: string;
  /** Central local midnight of `date`, as epoch ms. */
  startMs: number;
  /** Central local midnight of the following day, as epoch ms. */
  endMs: number;
};

/** Central local midnight of `date` as epoch ms (DST-aware). */
export function centralMidnight(date: string, zone: string = CENTRAL_TZ): number {
  const anchor = new Date(Date.parse(`${date}T12:00:00Z`));
  return Date.parse(`${date}T00:00:00Z`) - tzOffsetMinutesAt(anchor, zone) * 60_000;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Every Central calendar day the window [startMs, endMs) touches. The cache is
 * keyed by whole days so two probes over overlapping ranges share rows instead
 * of each fetching its own arbitrary window.
 */
export function centralDaysCovering(startMs: number, endMs: number, zone: string = CENTRAL_TZ): CacheDay[] {
  if (!(endMs > startMs)) return [];
  const first = dateStrInTz(new Date(startMs), zone);
  const last = dateStrInTz(new Date(endMs - 1), zone);
  const days: CacheDay[] = [];
  let cursor = first;
  let guard = 0;
  while (guard++ < 400) {
    const dayStart = centralMidnight(cursor, zone);
    const dayEnd = centralMidnight(addDays(cursor, 1), zone);
    days.push({ date: cursor, startMs: dayStart, endMs: dayEnd });
    if (cursor === last) break;
    cursor = addDays(cursor, 1);
  }
  return days;
}

/**
 * Is a cached day still trustworthy? Past days never change once fetched
 * (barring a Samsara log edit, which the weekly re-pull handles). A day that is
 * still in progress, or that was stored incomplete, goes stale quickly.
 */
export function isCacheDayFresh(
  row: { day_date: string; fetched_at: string; complete: boolean },
  nowMs: number,
  opts?: { openDayTtlMinutes?: number; maxAgeDays?: number },
): boolean {
  const fetchedAt = Date.parse(row.fetched_at);
  if (!Number.isFinite(fetchedAt)) return false;
  const ttlMs = (opts?.openDayTtlMinutes ?? 30) * 60_000;
  const dayEnd = centralMidnight(addDays(row.day_date, 1));
  const dayWasClosedWhenFetched = fetchedAt >= dayEnd;
  if (!row.complete || !dayWasClosedWhenFetched) return nowMs - fetchedAt < ttlMs;
  const maxAgeDays = opts?.maxAgeDays;
  if (maxAgeDays === undefined) return true;
  return nowMs - fetchedAt < maxAgeDays * 86_400_000;
}

export type AssignmentRow = {
  driverId: string;
  vehicleId: string;
  startMs: number;
  /** null means still open at the end of the fetched window. */
  endMs: number | null;
};

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Fill in a missing vehicle on an HOS segment from the driver-vehicle
 * assignment that overlaps it most. Segments that already name a vehicle are
 * left exactly as Samsara reported them.
 */
export function backfillSegmentVehicles<
  T extends { driverId: string; startMs: number; endMs: number; vehicleId: string | null },
>(segments: T[], assignments: AssignmentRow[]): { segments: T[]; filled: number } {
  if (!assignments.length) return { segments, filled: 0 };
  const byDriver = new Map<string, AssignmentRow[]>();
  for (const a of assignments) {
    const list = byDriver.get(a.driverId) ?? [];
    list.push(a);
    byDriver.set(a.driverId, list);
  }
  let filled = 0;
  const out = segments.map((seg) => {
    const current = (seg.vehicleId ?? "").trim();
    if (current && current !== "0") return seg;
    const candidates = byDriver.get(seg.driverId) ?? [];
    let best: { vehicleId: string; overlap: number } | null = null;
    for (const a of candidates) {
      const overlap = overlapMs(seg.startMs, seg.endMs, a.startMs, a.endMs ?? Number.MAX_SAFE_INTEGER);
      if (overlap <= 0) continue;
      if (!best || overlap > best.overlap) best = { vehicleId: a.vehicleId, overlap };
    }
    if (!best) return seg;
    filled++;
    return { ...seg, vehicleId: best.vehicleId };
  });
  return { segments: out, filled };
}
