/** Query keys that show estimated pallets and must refresh after a capacity save. */
export const CAPACITY_SAVE_QUERY_KEYS = [
  ["tc-settings"],
  ["tc-routes"],
  ["tc-forecast"],
  ["truck-forecast-board"],
  ["dispatch"],
] as const;

export function invalidateAfterCapacitySave(
  invalidate: (queryKey: readonly string[]) => void,
): void {
  for (const queryKey of CAPACITY_SAVE_QUERY_KEYS) invalidate(queryKey);
}
