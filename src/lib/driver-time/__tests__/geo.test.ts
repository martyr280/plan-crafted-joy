import { describe, expect, it } from "vitest";
import { haversineMeters, pointInCircle, pointInPolygon, matchGeofence, type Geofence } from "../geo";

const BHM = { latitude: 33.5186, longitude: -86.8104 };

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters(BHM, BHM)).toBe(0);
  });
  it("matches a known distance (Birmingham -> Dallas ~ 933 km)", () => {
    const DAL = { latitude: 32.7767, longitude: -96.797 };
    const m = haversineMeters(BHM, DAL);
    expect(m / 1000).toBeGreaterThan(900);
    expect(m / 1000).toBeLessThan(960);
  });
});

describe("pointInCircle", () => {
  it("includes a point inside the radius", () => {
    expect(pointInCircle({ latitude: 33.5188, longitude: -86.8104 }, BHM, 200)).toBe(true);
  });
  it("excludes a point outside the radius", () => {
    expect(pointInCircle({ latitude: 33.53, longitude: -86.8104 }, BHM, 200)).toBe(false);
  });
  it("rejects a zero radius", () => {
    expect(pointInCircle(BHM, BHM, 0)).toBe(false);
  });
});

describe("pointInPolygon", () => {
  const square = [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 },
    { latitude: 1, longitude: 1 },
    { latitude: 1, longitude: 0 },
  ];
  it("detects an interior point", () => {
    expect(pointInPolygon({ latitude: 0.5, longitude: 0.5 }, square)).toBe(true);
  });
  it("rejects an exterior point", () => {
    expect(pointInPolygon({ latitude: 1.5, longitude: 0.5 }, square)).toBe(false);
  });
  it("rejects degenerate polygons", () => {
    expect(pointInPolygon({ latitude: 0, longitude: 0 }, square.slice(0, 2))).toBe(false);
  });
});

describe("matchGeofence", () => {
  const fences: Geofence[] = [
    { id: "a", name: "Birmingham DC", hub: "Birmingham", circle: { ...BHM, radiusMeters: 300 } },
    {
      id: "b",
      name: "Polygon Yard",
      hub: "Dallas",
      polygon: [
        { latitude: 32, longitude: -97 },
        { latitude: 32, longitude: -96 },
        { latitude: 33, longitude: -96 },
        { latitude: 33, longitude: -97 },
      ],
    },
  ];
  it("returns the circle fence", () => {
    expect(matchGeofence(BHM, fences)?.id).toBe("a");
  });
  it("returns the polygon fence", () => {
    expect(matchGeofence({ latitude: 32.5, longitude: -96.5 }, fences)?.id).toBe("b");
  });
  it("returns null for no location", () => {
    expect(matchGeofence(null, fences)).toBeNull();
  });
  it("returns null when outside every fence", () => {
    expect(matchGeofence({ latitude: 40, longitude: -80 }, fences)).toBeNull();
  });
});
