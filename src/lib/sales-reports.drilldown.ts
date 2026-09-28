// Client-safe drill-down shaping for the Sales Reports manager KPI cards.
// Totals are derived from summarizeByRep over the same rows the overview uses,
// so the drawer total is identical (same summation order) to the card number.
import { isAtRisk, isBelowTargetActive, isWinBack, summarizeByRep, type SalesReportRow, type RepSummary } from "./sales-reports.shared";

export type DrilldownKind = "ytd" | "month" | "at_risk" | "win_back";
export const DRILLDOWN_KINDS: DrilldownKind[] = ["ytd", "month", "at_risk", "win_back"];

export type DrillRow = {
  rep_code: string;
  rep_name: string;
  cust_code: string;
  customer_name: string | null;
  city: string | null;
  state: string | null;
  price_level: string | null;
  total_value: number;
  y2025: number;
  y_current: number;
  ann_current: number;
  pct: number | null;
  month_sales: number;
  month_profit: number;
  keep_lvl_code: string | null;
  keep_lvl_shortfall: number | null;
  target: number | null;
  gap: number | null;
};

export type DrillRepRow = {
  rep_code: string;
  rep_name: string;
  customers: number;
  ytd: number;
  annualized: number;
  pct_vs_prior: number | null;
  month_sales: number;
  month_profit: number;
  active_customers: number;
};

export type Drilldown = {
  kind: DrilldownKind;
  total: number;
  count: number;
  rows: DrillRow[];
  reps: DrillRepRow[];
  /** at_risk only: informational "below target, still buying" rows. Not counted in total/count. */
  belowTarget: DrillRow[];
};

/** The number shown on the KPI card, computed exactly as ManagerOverview does. */
export function cardTotal(reps: RepSummary[], kind: DrilldownKind): number {
  const t = reps.reduce(
    (a, r) => ({ ytd: a.ytd + r.ytd, month: a.month + r.month_sales, risk: a.risk + r.at_risk, win: a.win + r.win_backs }),
    { ytd: 0, month: 0, risk: 0, win: 0 },
  );
  return kind === "ytd" ? t.ytd : kind === "month" ? t.month : kind === "at_risk" ? t.risk : t.win;
}

function slim(r: SalesReportRow): DrillRow {
  const target = r.keep_lvl_threshold ?? r.target_sales ?? null;
  const ann = r.ann_current ?? 0;
  return {
    rep_code: r.rep_code,
    rep_name: r.rep_name ?? r.rep_code,
    cust_code: r.cust_code,
    customer_name: r.customer_name,
    city: r.city,
    state: r.state,
    price_level: r.price_level,
    total_value: r.total_value ?? 0,
    y2025: r.y2025 ?? 0,
    y_current: r.y_current ?? 0,
    ann_current: ann,
    pct: r.pct ?? null,
    month_sales: r.month_sales ?? 0,
    month_profit: r.month_profit ?? 0,
    keep_lvl_code: r.keep_lvl_code,
    keep_lvl_shortfall: r.keep_lvl_shortfall ?? null,
    target,
    gap: target === null ? null : Math.max(0, target - ann),
  };
}

export function buildDrilldown(all: SalesReportRow[], kind: DrilldownKind): Drilldown {
  const summaries = summarizeByRep(all);
  const total = cardTotal(summaries, kind);
  const pred: (r: SalesReportRow) => boolean =
    kind === "ytd" ? (r) => (r.y_current ?? 0) !== 0
    : kind === "month" ? (r) => (r.month_sales ?? 0) !== 0
    : kind === "at_risk" ? isAtRisk
    : isWinBack;
  const rows = all.filter(pred).map(slim);
  const active = new Map<string, number>();
  for (const r of all) if ((r.month_sales ?? 0) !== 0) active.set(r.rep_code, (active.get(r.rep_code) ?? 0) + 1);
  const reps: DrillRepRow[] =
    kind === "ytd" || kind === "month"
      ? summaries.map((s) => ({
          rep_code: s.rep_code,
          rep_name: s.rep_name,
          customers: s.customers,
          ytd: s.ytd,
          annualized: s.annualized,
          pct_vs_prior: s.pct_vs_prior,
          month_sales: s.month_sales,
          month_profit: s.month_profit,
          active_customers: active.get(s.rep_code) ?? 0,
        }))
      : [];
  const belowTarget = kind === "at_risk" ? all.filter(isBelowTargetActive).map(slim) : [];
  return { kind, total, count: rows.length, rows, reps, belowTarget };
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
