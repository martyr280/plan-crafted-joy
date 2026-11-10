import { money } from "@/components/driver-time/DriverCard";

export type ReportDriver = {
  cost?: {
    cost: number | null;
    hourlyRate?: number | null;
    pricedMinutes?: number;
    excludedMinutes?: number;
    note?: string | null;
  } | null;
};

export type CostCoverage = {
  included: number;
  fullyPriced: number;
  partlyPriced: number;
  unpriced: number;
  pricedMinutes: number;
  excludedMinutes: number;
  sum: number;
};

export function hoursLabel(minutes: number): string {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours}h`;
}

/** A non-null cost with excluded minutes is only partly priced. A null cost is unpriced. */
export function driverCostCoverage(drivers: ReportDriver[] | undefined): CostCoverage {
  const included = drivers ?? [];
  let fullyPriced = 0;
  let partlyPriced = 0;
  let unpriced = 0;
  let pricedMinutes = 0;
  let excludedMinutes = 0;
  let sum = 0;
  for (const driver of included) {
    const cost = driver.cost?.cost;
    if (cost == null) {
      unpriced += 1;
      continue;
    }
    const excluded = driver.cost?.excludedMinutes ?? 0;
    const priced = driver.cost?.pricedMinutes ?? 0;
    sum += cost;
    if (excluded > 0) {
      partlyPriced += 1;
      pricedMinutes += priced;
      excludedMinutes += excluded;
    } else {
      fullyPriced += 1;
    }
  }
  return {
    included: included.length,
    fullyPriced,
    partlyPriced,
    unpriced,
    pricedMinutes,
    excludedMinutes,
    sum,
  };
}

export function estimatedCostFigure(
  canManage: boolean | undefined,
  drivers: ReportDriver[] | undefined,
): { partial: boolean; text: string } {
  if (!canManage) return { partial: false, text: "—" };
  const coverage = driverCostCoverage(drivers);
  if (coverage.fullyPriced + coverage.partlyPriced === 0) return { partial: false, text: "—" };
  if (coverage.partlyPriced > 0) {
    const unpricedNote = coverage.unpriced > 0 ? `; ${coverage.unpriced} unpriced` : "";
    const priced = hoursLabel(coverage.pricedMinutes);
    const excluded = hoursLabel(coverage.excludedMinutes);
    return {
      partial: true,
      text: `At least ${money(coverage.sum)} (${priced} priced, ${excluded} not costed${unpricedNote})`,
    };
  }
  if (coverage.unpriced > 0) {
    return {
      partial: true,
      text: `Partial: ${money(coverage.sum)} (${coverage.fullyPriced} fully priced, ${coverage.unpriced} unpriced)`,
    };
  }
  return { partial: false, text: money(coverage.sum) };
}

export function costCoverageNotice(coverage: CostCoverage): string | null {
  if (coverage.partlyPriced === 0 && coverage.unpriced === 0) return null;
  const counts = `${coverage.fullyPriced} fully priced, ${coverage.partlyPriced} partly priced, ${coverage.unpriced} unpriced.`;
  const subtotal =
    coverage.partlyPriced > 0
      ? ` ${hoursLabel(coverage.excludedMinutes)} not costed, so this is a known subtotal, not the full week.`
      : "";
  const missing =
    coverage.unpriced > 0
      ? " A missing hourly rate or missing Paycom hours leaves that driver unpriced. Warehouse time alone cannot establish overtime."
      : "";
  return `${counts}${subtotal}${missing}`;
}
