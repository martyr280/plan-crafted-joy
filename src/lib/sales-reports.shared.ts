// Client-safe shapes + insight predicates for Sales Reports.
import { KEEP_LEVEL_EXEMPT, KEEP_LEVEL_THRESHOLDS } from "./sales-annualized-template";

export type SalesReportRow = {
  id?: string;
  run_id?: string;
  rep_code: string;
  rep_name: string | null;
  cust_code: string;
  price_level: string | null;
  bg: string | null;
  customer_name: string | null;
  city: string | null;
  state: string | null;
  total_value: number | null;
  y2022: number | null;
  y2023: number | null;
  y2024: number | null;
  y2025: number | null;
  y_current: number | null;
  ann_current: number | null;
  pct: number | null;
  month_sales: number | null;
  month_profit: number | null;
  keep_lvl_code: string | null;
  keep_lvl_threshold: number | null;
  keep_lvl_shortfall: number | null;
  customer_id?: string | null;
  ship_to_id?: string | null;
  target_sales?: number | null;
  sales_rep_id?: string | null;
};

export type RepSummary = {
  rep_code: string;
  rep_name: string;
  customers: number;
  ytd: number;
  annualized: number;
  prior_year: number;
  pct_vs_prior: number | null;
  month_sales: number;
  month_profit: number;
  at_risk: number;
  declining: number;
  win_backs: number;
  /** False when P21 returned no price-level / keep-level data for this rep. */
  price_level_mapped: boolean;
};

/**
 * NDI's P21 install has no identified price-level / buying-group source yet
 * (dbo.customer has no price1/class_id1 — verified 2026-08-03), so those come
 * back NULL. Keep-level risk is meaningless until that mapping exists; callers
 * should show an "awaiting price-level mapping" state instead of zeros.
 */
export function hasPriceLevelMapping(rows: SalesReportRow[]): boolean {
  return rows.some(
    (r) =>
      !!r.price_level ||
      !!r.keep_lvl_code ||
      (r.keep_lvl_threshold !== null && r.keep_lvl_threshold !== undefined),
  );
}

export function isKeepLevelExempt(code: string | null | undefined): boolean {
  return !!code && (KEEP_LEVEL_EXEMPT as readonly string[]).includes(code.toUpperCase());
}

export function keepThresholdFor(row: SalesReportRow): number | null {
  if (row.keep_lvl_threshold !== null && row.keep_lvl_threshold !== undefined) return row.keep_lvl_threshold;
  const code = row.keep_lvl_code ?? row.price_level;
  return code ? (KEEP_LEVEL_THRESHOLDS[code.toUpperCase()] ?? null) : null;
}

/**
 * Keep-level at risk (rule changed 2026-09-28).
 * In plain words: the account EARNED its level last year (2025 sales at or above
 * its keep-level target) and is NOW on pace to lose it (annualized below target).
 * Exempt codes and accounts with no target are never at risk.
 * Why: the old rule ("annualized below target") flagged 615 accounts in run
 * 14e3338d, but only 6 of them met their target in 2025 and 244 had no sales in
 * 2025 or 2026. NDI customers almost never reach target, so the old rule flagged
 * nearly every account with a price level. New rule: 615 -> 6.
 */
export function isAtRisk(r: SalesReportRow): boolean {
  if (isKeepLevelExempt(r.keep_lvl_code)) return false;
  const t = keepThresholdFor(r);
  return t !== null && (r.y2025 ?? 0) >= t && (r.ann_current ?? 0) < t;
}

/**
 * Informational only (2026-09-28): buying this year but pacing below target,
 * and not at risk under the rule above. Must NOT feed the card, the rep table
 * "At risk" column, or the RepDetail risk badge.
 */
export function isBelowTargetActive(r: SalesReportRow): boolean {
  if (isKeepLevelExempt(r.keep_lvl_code)) return false;
  const t = keepThresholdFor(r);
  return t !== null && (r.y_current ?? 0) > 0 && (r.ann_current ?? 0) < t && !isAtRisk(r);
}

/** Annualized pace more than 20% below prior year. */
export function isDeclining(r: SalesReportRow): boolean {
  return r.pct !== null && r.pct !== undefined && r.pct < -0.2;
}

/** Meaningful prior-year customer with nothing in the latest month. */
export function isWinBack(r: SalesReportRow): boolean {
  return (r.y2025 ?? 0) >= 5000 && (r.month_sales ?? 0) === 0;
}

export function summarizeByRep(rows: SalesReportRow[]): RepSummary[] {
  const map = new Map<string, RepSummary>();
  for (const r of rows) {
    let s = map.get(r.rep_code);
    if (!s) {
      s = {
        rep_code: r.rep_code,
        rep_name: r.rep_name ?? r.rep_code,
        customers: 0,
        ytd: 0,
        annualized: 0,
        prior_year: 0,
        pct_vs_prior: null,
        month_sales: 0,
        month_profit: 0,
        at_risk: 0,
        declining: 0,
        win_backs: 0,
        price_level_mapped: false,
      };
      map.set(r.rep_code, s);
    }
    s.customers += 1;
    if (!!r.price_level || !!r.keep_lvl_code || (r.keep_lvl_threshold !== null && r.keep_lvl_threshold !== undefined)) {
      s.price_level_mapped = true;
    }
    s.ytd += r.y_current ?? 0;
    s.annualized += r.ann_current ?? 0;
    s.prior_year += r.y2025 ?? 0;
    s.month_sales += r.month_sales ?? 0;
    s.month_profit += r.month_profit ?? 0;
    if (isAtRisk(r)) s.at_risk += 1;
    if (isDeclining(r)) s.declining += 1;
    if (isWinBack(r)) s.win_backs += 1;
  }
  const out = [...map.values()];
  for (const s of out) {
    s.pct_vs_prior = s.prior_year > 0 ? (s.annualized - s.prior_year) / s.prior_year : null;
  }
  return out.sort((a, b) => b.ytd - a.ytd);
}
