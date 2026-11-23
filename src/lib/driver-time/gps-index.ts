// Indexed nearest-GPS lookup for detection (pure, client-safe).
//
// Replaces the linear scan in detect.ts with identical results. The old loop
// walked the whole sample array in array order, skipped other vehicles and
// unusable coordinates, skipped |dt| > tolerance, and kept a sample only when
// its delta was STRICTLY smaller — so the winner is the minimum delta and, on a
// tie, the sample that came first in the ARRAY (not first in time).
// Here: per vehicle, usable samples sorted by (timeMs, array position); binary
// search to t - tolerance, walk to t + tolerance, keep min delta, tie -> lowest
// array position. Same winner, O(log n + k) instead of O(n).

import { usableCoordinates } from "@/lib/driver-time/geo";

export type IndexedGps = { vehicleId: string; timeMs: number; latitude: number; longitude: number };

type Entry = { t: number; pos: number; s: IndexedGps };

export type GpsIndex = {
  nearest(vehicleId: string, t: number, toleranceMs: number): IndexedGps | null;
};

export function buildGpsIndex(samples: readonly IndexedGps[]): GpsIndex {
  const byVehicle = new Map<string, Entry[]>();
  samples.forEach((s, pos) => {
    if (!usableCoordinates(s.latitude, s.longitude)) return;
    const key = String(s.vehicleId);
    const list = byVehicle.get(key) ?? [];
    list.push({ t: s.timeMs, pos, s });
    byVehicle.set(key, list);
  });
  for (const list of byVehicle.values()) list.sort((a, b) => a.t - b.t || a.pos - b.pos);
  return {
    nearest(vehicleId, t, toleranceMs) {
      const list = byVehicle.get(String(vehicleId));
      if (!list?.length) return null;
      const lo = t - toleranceMs;
      let a = 0;
      let b = list.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if (list[m].t < lo) a = m + 1;
        else b = m;
      }
      let best: Entry | null = null;
      let bestDelta = Infinity;
      for (let i = a; i < list.length && list[i].t <= t + toleranceMs; i++) {
        const e = list[i];
        const delta = Math.abs(e.t - t);
        if (delta > toleranceMs) continue;
        if (delta < bestDelta || (delta === bestDelta && best && e.pos < best.pos)) {
          best = e;
          bestDelta = delta;
        }
      }
      return best?.s ?? null;
    },
  };
}
