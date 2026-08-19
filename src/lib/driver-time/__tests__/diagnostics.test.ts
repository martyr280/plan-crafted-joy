import { describe, expect, it } from "vitest";
import {
  buildStatusVocabulary,
  classifyFence,
  nearestFence,
} from "@/lib/driver-time/diagnostics.server";
import type { Geofence } from "@/lib/driver-time/geo";

describe("diagnostics helpers", () => {
  it("marks Samsara's SCREAMING_SNAKE statuses as not counted", () => {
    const seg = (status: string, minutes: number) => ({ status, startMs: 0, endMs: minutes * 60_000 });
    const rows = buildStatusVocabulary([
      ...Array.from({ length: 12 }, () => seg("ON_DUTY", 610.4 / 12)),
      ...Array.from({ length: 30 }, () => seg("DRIVING", 30)),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.countedAsWarehouseTime === false)).toBe(true);
    expect(rows[0]).toMatchObject({ status: "DRIVING", segments: 30, minutes: 900 });
    expect(rows.find((r) => r.status === "ON_DUTY")?.minutes).toBe(610);
  });

  it("recognises the engine's canonical statuses", () => {
    const seg = (status: string) => ({ status, startMs: 0, endMs: 60_000 });
    const rows = buildStatusVocabulary([
      ...Array.from({ length: 3 }, () => seg("onDuty")),
      seg("yardMove"),
      ...Array.from({ length: 5 }, () => seg("driving")),
    ]);
    expect(rows.find((r) => r.status === "onDuty")?.countedAsWarehouseTime).toBe(true);
    expect(rows.find((r) => r.status === "yardMove")?.countedAsWarehouseTime).toBe(true);
    expect(rows.find((r) => r.status === "driving")?.countedAsWarehouseTime).toBe(false);
  });

  it("computes nearest-fence distance for a pair ~400 m apart", () => {
    // 0.0036 degrees of latitude ≈ 400.1 m
    const fences: Geofence[] = [
      { id: "a", name: "Dallas DC", circle: { latitude: 32.7767, longitude: -96.797, radiusMeters: 150 } },
      { id: "b", name: "Far away", circle: { latitude: 41.0, longitude: -96.797, radiusMeters: 150 } },
    ];
    const near = nearestFence({ latitude: 32.7767 + 0.0036, longitude: -96.797 }, fences);
    expect(near.name).toBe("Dallas DC");
    expect(near.meters).toBeGreaterThan(395);
    expect(near.meters).toBeLessThan(405);
  });

  it("returns null distance without a resolved point", () => {
    expect(nearestFence(null, [])).toEqual({ name: null, meters: null });
  });

  it("classifies an address with no geofence as none", () => {
    expect(classifyFence({ circle: null, polygon: null })).toBe("none");
    expect(classifyFence({ circle: null, polygon: [] })).toBe("none");
    expect(
      classifyFence({ circle: { latitude: 1, longitude: 2, radiusMeters: 100 }, polygon: null }),
    ).toBe("circle");
    expect(
      classifyFence({
        circle: null,
        polygon: [
          { latitude: 1, longitude: 1 },
          { latitude: 1, longitude: 2 },
          { latitude: 2, longitude: 2 },
        ],
      }),
    ).toBe("polygon");
  });
});
