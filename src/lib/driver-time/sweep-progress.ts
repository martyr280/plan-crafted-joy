// Client-safe progress text for a resumable Driver Time sweep (pure).

export const GPS_VEHICLES_PER_UNIT = 3;

export type ProgressCursor = {
  days?: unknown[];
  roster?: unknown[];
  vehicleIds?: unknown[];
  dayIdx?: number;
  planIdx?: number;
  gpsDayIdx?: number;
  gpsChunkIdx?: number;
  detectIdx?: number;
};

/** Human cursor text for progress and the watchdog message. */
export function describeCursor(phase: string | null, c: ProgressCursor | null | undefined): string {
  const cur = c ?? {};
  const nDays = cur.days?.length ?? 0;
  const nDrivers = cur.roster?.length ?? 0;
  switch (phase) {
    case "fetch_hos":
      return `HOS day ${Math.min((cur.dayIdx ?? 0) + 1, nDays)} of ${nDays}`;
    case "fetch_assign":
      return `assignments day ${Math.min((cur.dayIdx ?? 0) + 1, nDays)} of ${nDays}`;
    case "plan_vehicles":
      return `vehicle plan, driver ${Math.min(cur.planIdx ?? 0, nDrivers)} of ${nDrivers}`;
    case "fetch_gps": {
      const chunks = Math.max(1, Math.ceil((cur.vehicleIds?.length ?? 0) / GPS_VEHICLES_PER_UNIT));
      return `GPS day ${Math.min((cur.gpsDayIdx ?? 0) + 1, nDays)} of ${nDays}, chunk ${(cur.gpsChunkIdx ?? 0) + 1} of ${chunks}`;
    }
    case "detect":
      return `driver ${Math.min((cur.detectIdx ?? 0) + 1, nDrivers)} of ${nDrivers}`;
    case "finalize":
      return "finalizing";
    default:
      return phase ?? "not started";
  }
}

