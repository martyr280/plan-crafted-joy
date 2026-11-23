import "./network-block";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWarehouseEvents } from "../detect";
import { detectWarehouseEvents as legacyDetect } from "./fixtures/detect-legacy";
import { buildGpsIndex } from "../gps-index";
import { usableCoordinates } from "../geo";

// Parity against the OLD linear GPS scan, kept verbatim in fixtures/detect-legacy.ts.
// Fixtures: every *.json under fixtures/ (Outler 9/10, 9/17, 9/21, 9/22, 9/24,
// Farahkhan 9/16, McGinnis 9/11) plus seeded random cases with ties.

const dir = join(__dirname, "fixtures");
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json"));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

const variants = [
  { basis: "presence" as const },
  { basis: "presence" as const, remarkRule: true },
  { basis: "presence" as const, clockOutTail: true },
  { basis: "onduty" as const },
];

function input(fx: any, gps: any[], opts: Record<string, unknown>) {
  return {
    driver: fx.driver,
    segments: fx.segments,
    warehouses: fx.fences,
    gpsSamples: gps,
    options: { tzOffsetMinutes: fx.tzOffsetMinutes, eldDayStartHour: 0, thresholdMinutes: 90, mergeGapMinutes: 10, hubTags: fx.tags, ...opts },
  };
}

// Deterministic PRNG.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("1. indexed GPS lookup == old linear scan", () => {
  for (const f of fixtures) {
    for (const v of variants) {
      it(`${f} ${JSON.stringify(v)}`, () => {
        const fx = load(f);
        expect(detectWarehouseEvents(input(fx, fx.gps, v) as any)).toEqual(legacyDetect(input(fx, fx.gps, v) as any));
      });
    }
  }

  it("fixtures with GPS-only location (log coordinates stripped) and shuffled, tie-heavy samples", () => {
    for (const f of fixtures) {
      const fx = load(f);
      const r = rng(f.length * 7919);
      const segs = fx.segments.map((s: any) => ({ ...s, latitude: null, longitude: null }));
      // Shuffle and add exact-time duplicates with different coordinates and symmetric +/- ties.
      const gps = [...fx.gps];
      for (const g of fx.gps.slice(0, 200)) {
        gps.push({ ...g, latitude: g.latitude + 0.01 });
        gps.push({ ...g, timeMs: g.timeMs + 120_000 }, { ...g, timeMs: g.timeMs - 120_000, longitude: g.longitude + 0.02 });
      }
      for (let i = gps.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [gps[i], gps[j]] = [gps[j], gps[i]];
      }
      for (const v of variants) {
        const a = detectWarehouseEvents({ ...input(fx, gps, v), segments: segs } as any);
        const b = legacyDetect({ ...input(fx, gps, v), segments: segs } as any);
        expect(a).toEqual(b);
      }
    }
  });

  it("random nearest() queries match the linear rule (min delta, tie -> earliest array position)", () => {
    const r = rng(42);
    for (let round = 0; round < 50; round++) {
      const samples = Array.from({ length: 300 }, () => ({
        vehicleId: `v${Math.floor(r() * 3)}`,
        timeMs: Math.floor(r() * 40) * 60_000,
        latitude: r() < 0.05 ? 0 : 30 + r(),
        longitude: r() < 0.05 ? 0 : -90 + r(),
      }));
      const idx = buildGpsIndex(samples);
      for (let q = 0; q < 100; q++) {
        const vid = `v${Math.floor(r() * 3)}`;
        const t = Math.floor(r() * 80) * 30_000;
        const tol = Math.floor(r() * 10) * 60_000;
        let best: any = null;
        let bestD = Infinity;
        for (const s of samples) {
          if (s.vehicleId !== vid) continue;
          if (!usableCoordinates(s.latitude, s.longitude)) continue;
          const d = Math.abs(s.timeMs - t);
          if (d > tol) continue;
          if (!best || d < bestD) {
            best = s;
            bestD = d;
          }
        }
        expect(idx.nearest(vid, t, tol)).toBe(best);
      }
    }
  });
});

describe("2. per-driver GPS subset == full GPS array", () => {
  for (const f of fixtures) {
    it(f, () => {
      const fx = load(f);
      const own = new Set(fx.segments.map((s: any) => String(s.vehicleId)).filter(Boolean));
      // Interleave other vehicles' samples at the same times and places.
      const noisy: any[] = [];
      fx.gps.forEach((g: any, i: number) => {
        noisy.push({ ...g, vehicleId: `other-${i % 4}` });
        noisy.push(g);
      });
      const subset = noisy.filter((g) => own.has(String(g.vehicleId)));
      for (const v of variants) {
        const full = detectWarehouseEvents(input(fx, noisy, v) as any);
        expect(detectWarehouseEvents(input(fx, subset, v) as any)).toEqual(full);
        expect(full).toEqual(legacyDetect(input(fx, noisy, v) as any));
      }
    });
  }
});
