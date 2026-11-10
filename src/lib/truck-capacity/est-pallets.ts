// Estimated pallets from cube and the route's truck-full settings.
//
// est_pallets = cube / (cube_full_truck_ft3 / pallets_full_truck)
// Division is numeric (IEEE float), never integer truncation.
// Any missing, zero, or negative input yields null. Callers show that as
// "unavailable". A stored est_pallets value is not a fallback: snapshots written
// before pallets/full was set, or after a route edit, are recomputed on read.

export type PalletCapacity = {
  cube: number | string | null | undefined;
  cubeFullTruckFt3: number | string | null | undefined;
  palletsFullTruck: number | string | null | undefined;
};

export const EST_PALLETS_UNAVAILABLE = "unavailable";

function positive(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Null when the estimate cannot be made. Never returns 0. */
export function estimatePallets(input: PalletCapacity): number | null {
  const cube = positive(input.cube);
  const full = positive(input.cubeFullTruckFt3);
  const pallets = positive(input.palletsFullTruck);
  if (cube == null || full == null || pallets == null) return null;
  const perPallet = full / pallets;
  if (!Number.isFinite(perPallet) || perPallet <= 0) return null;
  const est = cube / perPallet;
  if (!Number.isFinite(est) || est <= 0) return null;
  return est;
}

/**
 * Display value for a demand row. `storedEstPallets` is accepted so callers
 * pass the cached column explicitly; it is never used.
 */
export function resolveDisplayedEstPallets(
  input: PalletCapacity & { storedEstPallets?: number | string | null },
): number | null {
  return estimatePallets(input);
}

/**
 * One truck run that may cover several ship dates. Every booked day must have
 * a positive cube; a missing day that has no demand row is omitted by the
 * caller. An empty set is unavailable, not zero pallets.
 */
export function estimateRunPallets(
  days: readonly { cube: number | string | null | undefined }[],
  capacity: Omit<PalletCapacity, "cube">,
): number | null {
  if (!days.length) return null;
  let sum = 0;
  for (const day of days) {
    const cube = positive(day.cube);
    if (cube == null) return null;
    sum += cube;
  }
  return estimatePallets({ cube: sum, ...capacity });
}

export function formatEstPallets(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return EST_PALLETS_UNAVAILABLE;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export type PalletTotalStatus = "known" | "partial" | "unavailable";

/** A total that never treats an unknown estimate as zero. */
export type PalletTotal = {
  status: PalletTotalStatus;
  /** Set only when every input is a positive estimate. */
  total: number | null;
  /** Sum of the estimates that could be made. Null when none could. */
  known: number | null;
  unknownCount: number;
};

/**
 * Sum stop or day estimates. Zero, null, and non-finite values are unknown,
 * not a contribution of 0. A mix is partial: `known` is the sum of the ones
 * that exist, and `total` stays null so it cannot be read as complete.
 */
export function sumEstPallets(values: readonly (number | null | undefined)[]): PalletTotal {
  let knownSum = 0;
  let knownCount = 0;
  let unknownCount = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value) || value <= 0) unknownCount += 1;
    else {
      knownSum += value;
      knownCount += 1;
    }
  }
  if (knownCount === 0) return { status: "unavailable", total: null, known: null, unknownCount };
  if (unknownCount > 0) return { status: "partial", total: null, known: knownSum, unknownCount };
  return { status: "known", total: knownSum, known: knownSum, unknownCount: 0 };
}

export function formatPalletTotal(total: PalletTotal): string {
  if (total.status === "partial" && total.known != null)
    return `${formatEstPallets(total.known)} partial`;
  if (total.status === "known") return formatEstPallets(total.total);
  return EST_PALLETS_UNAVAILABLE;
}

export type DemandCubeRow = {
  id?: string | null;
  ship_date: string;
  total_cube_ft?: unknown;
  snapshot_at?: string | null;
};

/**
 * Newest snapshot per ship date. Equal snapshot times break on id descending
 * so a page cap cannot pick an arbitrary older row when the tie is stable.
 * Stored est_pallets is not an input.
 */
export function latestDemandCube(rows: readonly DemandCubeRow[]): Map<string, number | null> {
  const sorted = [...rows].sort((a, b) => {
    const bySnap = String(b.snapshot_at ?? "").localeCompare(String(a.snapshot_at ?? ""));
    if (bySnap !== 0) return bySnap;
    return String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });
  const latest = new Map<string, number | null>();
  for (const row of sorted) {
    if (latest.has(row.ship_date)) continue;
    const raw = row.total_cube_ft;
    const n = raw == null || raw === "" ? null : Number(raw);
    latest.set(row.ship_date, n != null && Number.isFinite(n) ? n : null);
  }
  return latest;
}

export type RoutePalletCapacity = {
  id: string;
  cube_full_truck_ft3?: number | string | null;
  pallets_full_truck?: number | string | null;
};

/** Copy the route's current capacity onto demand rows so readers recompute. */
export function attachRouteCapacity<T extends { route_id: string }>(
  demand: readonly T[],
  routes: readonly RoutePalletCapacity[],
): (T & {
  cube_full_truck_ft3: number | string | null;
  pallets_full_truck: number | string | null;
})[] {
  const byId = new Map(routes.map((r) => [r.id, r]));
  return demand.map((row) => {
    const route = byId.get(row.route_id);
    return {
      ...row,
      cube_full_truck_ft3: route?.cube_full_truck_ft3 ?? null,
      pallets_full_truck: route?.pallets_full_truck ?? null,
    };
  });
}
