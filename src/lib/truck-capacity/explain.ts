// Group ridge coefficients × feature values into human-readable drivers.

export type DriverGroup =
  | "lane" | "weekday" | "month" | "trend" | "recent" | "hub" | "truck";

function groupOf(name: string): DriverGroup | null {
  if (name === "intercept") return null;
  if (name.startsWith("dow_")) return "weekday";
  if (name.startsWith("month_")) return "month";
  if (name.startsWith("hub_")) return "hub";
  if (name === "truck_box") return "truck";
  if (name === "trend_years") return "trend";
  if (name.startsWith("lag_")) return "recent";
  if (name.startsWith("route_")) return "lane";
  return null;
}

const LABEL: Record<DriverGroup, string> = {
  lane: "lane baseline",
  weekday: "weekday",
  month: "season",
  trend: "trend",
  recent: "recent form",
  hub: "hub",
  truck: "truck type",
};

export function groupContributions(
  coefficients: number[],
  featureNames: string[],
  x: number[],
): Array<{ group: DriverGroup; contribution: number }> {
  const acc = new Map<DriverGroup, number>();
  for (let i = 0; i < featureNames.length; i++) {
    const g = groupOf(featureNames[i]);
    if (!g) continue;
    const c = (coefficients[i] ?? 0) * (x[i] ?? 0);
    acc.set(g, (acc.get(g) ?? 0) + c);
  }
  return [...acc.entries()]
    .map(([group, contribution]) => ({ group, contribution }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

export function driverSummary(
  groups: Array<{ group: DriverGroup; contribution: number }>,
  p21Active: boolean,
): string {
  const parts = groups
    .filter((g) => Math.abs(g.contribution) >= 0.005)
    .slice(0, 4)
    .map((g) => `${LABEL[g.group]} ${g.contribution >= 0 ? "+" : ""}${g.contribution.toFixed(2)}`);
  const p21 = p21Active ? "P21 open orders above forecast (guard active)" : "P21 open orders below forecast (guard inactive)";
  return parts.length > 0 ? `${parts.join(", ")}; ${p21}` : p21;
}
