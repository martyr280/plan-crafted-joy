// Recompute saved dispatch pallet estimates from each stop's cube and the
// route's current truck-full settings. A stored est_pallets value, including 0,
// is not a fallback. This does not read or write historical pallet_count.

import {
  estimatePallets,
  sumEstPallets,
  type PalletCapacity,
  type PalletTotal,
} from "@/lib/truck-capacity/est-pallets";

type StopLike = {
  est_cube_ft?: number | string | null;
  est_pallets?: number | string | null;
};

export function rehydrateDispatchPallets<T extends StopLike>(
  stops: readonly T[],
  capacity: Omit<PalletCapacity, "cube">,
): { stops: Array<T & { est_pallets: number | null }>; total: PalletTotal } {
  const next = stops.map((stop) => {
    const estimated = estimatePallets({
      cube: stop.est_cube_ft,
      cubeFullTruckFt3: capacity.cubeFullTruckFt3,
      palletsFullTruck: capacity.palletsFullTruck,
    });
    return { ...stop, est_pallets: estimated };
  });
  return { stops: next, total: sumEstPallets(next.map((stop) => stop.est_pallets)) };
}

export function throwIfSupabaseError(
  error: { message?: string } | null | undefined,
  label: string,
): void {
  if (error) throw new Error(`${label}: ${error.message ?? "request failed"}`);
}
