// Cost estimate for flagged warehouse time.
//
// Paycom has no API, so weekly hours come from Samsara unless someone pastes
// the real Paycom number, which always wins. A driver with no rate on file is
// reported as "no rate on file" — never as $0, which would read as free labour.

export type CostInput = {
  driverId: string;
  driverName?: string | null;
  /** Total on-duty hours for the week per Samsara. */
  samsaraWeekHours: number;
  /** Pasted Paycom hours; takes precedence when present. */
  paycomHours?: number | null;
  /** Flagged (warehouse dwell) hours for the week. */
  flaggedHours: number;
  hourlyRate?: number | null;
};

export type CostEstimate = {
  driverId: string;
  driverName: string | null;
  weekHours: number;
  hoursSource: "paycom" | "samsara";
  flaggedHours: number;
  hourlyRate: number | null;
  multiplier: number | null;
  overtime: boolean;
  cost: number | null;
  note: string | null;
};

export const OT_THRESHOLD_HOURS = 40;

export function estimateCost(input: CostInput): CostEstimate {
  const usePaycom = typeof input.paycomHours === "number" && Number.isFinite(input.paycomHours);
  const weekHours = usePaycom ? Number(input.paycomHours) : Number(input.samsaraWeekHours || 0);
  const overtime = weekHours >= OT_THRESHOLD_HOURS;
  const rate = typeof input.hourlyRate === "number" && Number.isFinite(input.hourlyRate) && input.hourlyRate > 0
    ? input.hourlyRate
    : null;
  const multiplier = overtime ? 1.5 : 1;
  const flaggedHours = Math.max(0, Number(input.flaggedHours || 0));

  return {
    driverId: input.driverId,
    driverName: input.driverName ?? null,
    weekHours: round2(weekHours),
    hoursSource: usePaycom ? "paycom" : "samsara",
    flaggedHours: round2(flaggedHours),
    hourlyRate: rate,
    multiplier: rate === null ? null : multiplier,
    overtime,
    cost: rate === null ? null : round2(flaggedHours * rate * multiplier),
    note: rate === null ? "no rate on file" : usePaycom ? null : "hours estimated from Samsara",
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
