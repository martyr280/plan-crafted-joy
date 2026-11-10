import { money } from "@/components/driver-time/DriverCard";

export type ReportDriver = {
  cost?: { cost: number | null; hourlyRate?: number | null } | null;
};

/** Coverage comes from computed costs. A known hourly rate with a null cost is still unpriced. */
export function driverCostCoverage(drivers: ReportDriver[] | undefined) {
  const included = drivers ?? [];
  let priced = 0;
  let sum = 0;
  for (const driver of included) {
    const cost = driver.cost?.cost;
    if (cost == null) continue;
    priced += 1;
    sum += cost;
  }
  return { included: included.length, priced, unpriced: included.length - priced, sum };
}

export function estimatedCostFigure(
  canManage: boolean | undefined,
  drivers: ReportDriver[] | undefined,
): { partial: boolean; text: string } {
  if (!canManage) return { partial: false, text: "—" };
  const coverage = driverCostCoverage(drivers);
  if (coverage.priced === 0) return { partial: false, text: "—" };
  if (coverage.unpriced > 0) {
    return {
      partial: true,
      text: `Partial: ${money(coverage.sum)} (${coverage.priced} of ${coverage.included} drivers priced)`,
    };
  }
  return { partial: false, text: money(coverage.sum) };
}
