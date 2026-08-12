// Pure geo helpers for warehouse geofence matching. No I/O.

export type LatLon = { latitude: number; longitude: number };

const EARTH_RADIUS_M = 6371008.8;

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointInCircle(p: LatLon, center: LatLon, radiusMeters: number): boolean {
  if (!(radiusMeters > 0)) return false;
  return haversineMeters(p, center) <= radiusMeters;
}

/**
 * Ray-casting point-in-polygon. Vertices in order; the ring is closed
 * implicitly. Longitude is x, latitude is y — fine for warehouse-sized
 * polygons well away from the antimeridian.
 */
export function pointInPolygon(p: LatLon, poly: LatLon[]): boolean {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].longitude;
    const yi = poly[i].latitude;
    const xj = poly[j].longitude;
    const yj = poly[j].latitude;
    const intersects =
      yi > p.latitude !== yj > p.latitude &&
      p.longitude < ((xj - xi) * (p.latitude - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export type Geofence = {
  id: string;
  name: string;
  hub?: string | null;
  tz?: string | null;
  circle?: { latitude: number; longitude: number; radiusMeters: number } | null;
  polygon?: LatLon[] | null;
};

export function pointInGeofence(p: LatLon, g: Geofence): boolean {
  if (g.polygon && g.polygon.length >= 3) return pointInPolygon(p, g.polygon);
  if (g.circle) return pointInCircle(p, g.circle, g.circle.radiusMeters);
  return false;
}

/** First matching geofence, or null. */
export function matchGeofence(p: LatLon | null, fences: Geofence[]): Geofence | null {
  if (!p) return null;
  for (const g of fences) if (pointInGeofence(p, g)) return g;
  return null;
}
