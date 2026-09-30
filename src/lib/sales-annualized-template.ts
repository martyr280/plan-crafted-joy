import { CENTRAL_TZ, dateStrInTz } from "@/lib/tz";
// ═══ Sales Reports definition — the ONE place for these rules ═══════════════
// Adopted 2026-09-30 (Marty approved). Matches NDI Aug 2026 files: 366/377 rows
// before restock rule (product group 95 added after that check).
// Replaces the 2026-09-28 build on vwFactShipToSales (REGPROD only) +
// vwShipToMaster ("current rep on the ship-to owns all history").
//
// Rules (each also has a pure TS mirror below, unit-tested):
//  1. Source: P21.dbo.invoice_hdr + invoice_line through the bridge, invoice_date basis.
//  2. Lines: every invoice line EXCEPT product_group_id IS NULL, product groups
//     10 (freight), 50 (delivery/install), and item 999999 (excluded everywhere).
//  2a. MONTH-ONLY exclusion (corrected 2026-09-30): groups 95 (restocking fee),
//     9908, 9910, 9911 are dropped from Month Sales / Month Profit ONLY. YTD, Ann,
//     Pct, Keep Lvl, Total Value and prior years INCLUDE them (= candidate_v1).
//     Evidence: excluding them everywhere put YTD off NDI by 15478 -628.80,
//     10494 -8.00, 11432 -6.00; NDI's YTD equals candidate_v1 exactly (August
//     9911 lines included); August Month Sales ties either way. 9912 always KEPT.
//  3. Kits/suites: a line that has component lines (invoice_line_uid_parent points
//     at it) is dropped; the components are counted.
//  4. Rep: MIN(oe_hdr_salesrep.salesrep_id) for the invoice's order; if the order
//     has no rep, invoice_hdr.salesrep_id. A line with neither has no rep and is
//     not put on any rep's report.
//  5. Row = (rep, customer_id). A customer can appear under several reps.
//  6. Year 2022..2025 = full calendar years; Year current = Jan 1 .. end of the
//     report month; later months are never read. Prior years use rules 2-4 too.
//  7. Total Value = Y2022+Y2023+Y2024+Y2025+Year current.
//     Ann current = Year current x 12 / report month.
//     Pct = Ann current / prior-year sales - 1; blank when prior year is 0.
//     Month Profit = extended_price - cogs_amount, rounded to cents.
//  8. Keep Lvl: BG ISG/OP -> the BG code; price level with a positive target
//     (vwCustomerPricing.TargetSales: L1 450,000, L2 200,000, L3 100,000,
//     L4 25,000) -> target - Year current (NOT floored at 0); any other price
//     level (L5, MML1, MML3, E2G, ...) -> the price-level code; else blank.
//  9. Row inclusion: the row appears only if some year 2022..current has
//     non-zero sales. No zero-everything rows.
// 10. Price level / BG / name / city / state: vwCustomerPricing and the
//     customer's primary ship-to (ShipToID = CustomerID) in vwShipToMaster,
//     name falling back to P21.dbo.customer.
//
// Keep the SQL single-statement and comment-free: the installed agent (v1.0.0)
// rejects semicolons and `--`, and sanitizeBridgeSql strips them anyway.
// ════════════════════════════════════════════════════════════════════════════

const DB = "P21_Analytics_PLAY.Sales";

/** Rule 2: excluded from every column. */
export const EXCLUDED_PRODUCT_GROUPS = ["10", "50"] as const;
/** Rule 2a: excluded from the report-month columns only. */
export const MONTH_ONLY_EXCLUDED_GROUPS = ["95", "9908", "9910", "9911"] as const;
export const EXCLUDED_ITEMS = ["999999"] as const;
export const KEEP_LVL_BG_CODES = ["ISG", "OP"] as const;

// ── Pure mirrors of the rules (unit-tested; the run cross-checks them) ──────

/** Rules 2-3: does this invoice line count toward sales? */
export function isLineCounted(line: { product_group_id: string | null; item_id: string | null; hasComponentLines: boolean }): boolean {
  if (line.product_group_id === null || line.product_group_id === undefined) return false;
  if ((EXCLUDED_PRODUCT_GROUPS as readonly string[]).includes(String(line.product_group_id).trim())) return false;
  if (line.item_id === null || (EXCLUDED_ITEMS as readonly string[]).includes(String(line.item_id).trim())) return false;
  return !line.hasComponentLines;
}

/** Rule 2a: does a counted line also count toward Month Sales / Month Profit? */
export function isLineInMonthColumns(line: { product_group_id: string | null; item_id: string | null; hasComponentLines: boolean }): boolean {
  if (!isLineCounted(line)) return false;
  return !(MONTH_ONLY_EXCLUDED_GROUPS as readonly string[]).includes(String(line.product_group_id).trim());
}

/** Rule 4: lowest order rep (SQL MIN on text), else the invoice header rep, else null. */
export function attributeRep(orderReps: (string | null)[], invoiceRep: string | null): string | null {
  const reps = orderReps.filter((r): r is string => !!r && r.trim() !== "");
  if (reps.length) return reps.reduce((a, b) => (b < a ? b : a));
  return invoiceRep && invoiceRep.trim() !== "" ? invoiceRep : null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Rule 8. */
export function keepLevel(bg: string | null, priceLevel: string | null, target: number | null, ytd: number):
  { kind: "code"; code: string } | { kind: "number"; value: number; threshold: number } | null {
  const b = bg?.trim().toUpperCase();
  if (b && (KEEP_LVL_BG_CODES as readonly string[]).includes(b)) return { kind: "code", code: b };
  if (target !== null && target > 0) return { kind: "number", value: round2(target - ytd), threshold: target };
  if (priceLevel && priceLevel.trim()) return { kind: "code", code: priceLevel.trim() };
  return null;
}

/** Rule 9. */
export function includeRow(a: { y2022: number; y2023: number; y2024: number; y2025: number; ytd: number }): boolean {
  return a.y2022 !== 0 || a.y2023 !== 0 || a.y2024 !== 0 || a.y2025 !== 0 || a.ytd !== 0;
}

/** Rule 7. */
export function deriveColumns(a: { y2022: number; y2023: number; y2024: number; y2025: number; ytd: number; priorYear: number }, month: number) {
  const ann = round2((a.ytd * 12) / month);
  return {
    total_value: round2(a.y2022 + a.y2023 + a.y2024 + a.y2025 + a.ytd),
    ann_current: ann,
    pct: a.priorYear === 0 ? null : Math.round((ann / a.priorYear - 1) * 10000) / 10000,
  };
}

/** Render the SQL with already-validated literal fragments. repFilter null = all reps. */
function renderSalesSql(repFilter: string | null, y: string, m: string): string {
  const groups = EXCLUDED_PRODUCT_GROUPS.map((g) => `'${g}'`).join(", ");
  const monthOnly = MONTH_ONLY_EXCLUDED_GROUPS.map((g) => `'${g}'`).join(", ");
  const items = EXCLUDED_ITEMS.map((g) => `'${g}'`).join(", ");
  const prior = /^\d+$/.test(y) ? String(Number(y) - 1) : `(${y} - 1)`;
  const where = repFilter ? `\nWHERE g.Rep = ${repFilter}` : "";
  return `WITH L AS (
  SELECT h.order_no, h.customer_id, h.salesrep_id AS InvRep, YEAR(h.invoice_date) AS Yr, MONTH(h.invoice_date) AS Mo,
    il.extended_price AS Ep, il.extended_price - il.cogs_amount AS Pr,
    CASE WHEN il.product_group_id IN (${monthOnly}) THEN 0 ELSE 1 END AS InMo
  FROM P21.dbo.invoice_hdr h
  JOIN P21.dbo.invoice_line il ON il.invoice_no = h.invoice_no
  WHERE h.invoice_date >= '2022-01-01'
    AND h.invoice_date < DATEADD(month, 1, DATEFROMPARTS(${y}, ${m}, 1))
    AND il.product_group_id IS NOT NULL
    AND il.product_group_id NOT IN (${groups})
    AND il.item_id NOT IN (${items})
    AND NOT EXISTS (SELECT 1 FROM P21.dbo.invoice_line c WHERE c.invoice_no = il.invoice_no AND c.invoice_line_uid_parent = il.invoice_line_uid)
),
O AS (
  SELECT order_number, MIN(salesrep_id) AS OrderRep FROM P21.dbo.oe_hdr_salesrep GROUP BY order_number
),
A AS (
  SELECT ISNULL(O.OrderRep, L.InvRep) AS Rep, L.customer_id AS CustomerID, L.Yr, L.Mo, L.Ep, L.Pr, L.InMo
  FROM L LEFT JOIN O ON O.order_number = L.order_no
),
G AS (
  SELECT Rep, CustomerID,
    SUM(CASE WHEN Yr = 2022 THEN Ep ELSE 0 END) AS Sales2022,
    SUM(CASE WHEN Yr = 2023 THEN Ep ELSE 0 END) AS Sales2023,
    SUM(CASE WHEN Yr = 2024 THEN Ep ELSE 0 END) AS Sales2024,
    SUM(CASE WHEN Yr = 2025 THEN Ep ELSE 0 END) AS Sales2025,
    SUM(CASE WHEN Yr = ${y} THEN Ep ELSE 0 END) AS SalesYTD,
    SUM(CASE WHEN Yr = ${prior} THEN Ep ELSE 0 END) AS PriorYear,
    SUM(CASE WHEN Yr = ${y} AND Mo = ${m} AND InMo = 1 THEN Ep ELSE 0 END) AS MonthSales,
    SUM(CASE WHEN Yr = ${y} AND Mo = ${m} AND InMo = 1 THEN Pr ELSE 0 END) AS MonthProfit
  FROM A
  GROUP BY Rep, CustomerID
),
R AS (
  SELECT SalesRepID, MAX(SalesRepName) AS SalesRepName FROM ${DB}.vwShipToMaster GROUP BY SalesRepID
),
CT AS (
  SELECT CAST(id AS varchar(32)) AS id, MAX(LTRIM(RTRIM(ISNULL(first_name, '') + ' ' + ISNULL(last_name, '')))) AS nm FROM P21.dbo.contacts GROUP BY CAST(id AS varchar(32))
),
C AS (
  SELECT customer_id, MAX(customer_name) AS customer_name FROM P21.dbo.customer GROUP BY customer_id
),
B AS (
  SELECT g.*, sm.ShipToName, C.customer_name, sm.City, sm.State, sm.BuyingGroup, cp.PriceLevel, cp.TargetSales,
    ISNULL(R.SalesRepName, CT.nm) AS RepName
  FROM G g
  LEFT JOIN ${DB}.vwShipToMaster sm ON sm.CustomerID = g.CustomerID AND sm.ShipToID = g.CustomerID
  LEFT JOIN ${DB}.vwCustomerPricing cp ON cp.CustomerID = g.CustomerID
  LEFT JOIN C ON C.customer_id = g.CustomerID
  LEFT JOIN R ON R.SalesRepID = g.Rep
  LEFT JOIN CT ON CT.id = CAST(g.Rep AS varchar(32))${where}
)
SELECT
  b.Rep AS [Rep],
  b.RepName AS [RepName],
  b.CustomerID AS [Cust Code],
  b.PriceLevel AS [Price],
  CASE WHEN b.BuyingGroup IS NULL THEN 'N' ELSE b.BuyingGroup END AS [BG],
  ISNULL(b.ShipToName, b.customer_name) AS [Customer Name],
  b.City AS [City],
  b.State AS [St],
  CAST(b.Sales2022 + b.Sales2023 + b.Sales2024 + b.Sales2025 + b.SalesYTD AS decimal(19,2)) AS [Total Value],
  CAST(b.Sales2022 AS decimal(19,2)) AS [Year 2022],
  CAST(b.Sales2023 AS decimal(19,2)) AS [Year 2023],
  CAST(b.Sales2024 AS decimal(19,2)) AS [Year 2024],
  CAST(b.Sales2025 AS decimal(19,2)) AS [Year 2025],
  CAST(b.SalesYTD AS decimal(19,2)) AS [Year Current],
  CAST(b.SalesYTD * 12.0 / ${m} AS decimal(19,2)) AS [Ann Current],
  CAST(CASE WHEN b.PriorYear = 0 THEN NULL ELSE (b.SalesYTD * 12.0 / ${m}) / b.PriorYear - 1 END AS decimal(19,4)) AS [Pct],
  CAST(b.MonthSales AS decimal(19,2)) AS [Month Sales],
  CAST(b.MonthProfit AS decimal(19,2)) AS [Month Profit],
  CASE
    WHEN b.BuyingGroup IN ('ISG', 'OP') THEN b.BuyingGroup
    WHEN b.TargetSales > 0 THEN CONVERT(varchar(30), CAST(b.TargetSales - b.SalesYTD AS decimal(19,2)))
    ELSE b.PriceLevel
  END AS [Keep Lvl],
  CAST(b.PriorYear AS decimal(19,2)) AS [PriorYear],
  b.CustomerID,
  b.BuyingGroup,
  b.PriceLevel,
  b.TargetSales
FROM B b
WHERE b.Sales2022 <> 0 OR b.Sales2023 <> 0 OR b.Sales2024 <> 0 OR b.Sales2025 <> 0 OR b.SalesYTD <> 0
ORDER BY b.Rep, [Total Value] DESC`;
}

export type SalesReportSqlInput = { repCode?: string | null; year: number; month: number };

/** Validated, fully-substituted report SQL for one period; repCode limits it to one rep, omitted = every rep. */
export function buildSalesReportSql({ repCode, year, month }: SalesReportSqlInput): string {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error(`Invalid year: ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);
  if (repCode === undefined || repCode === null) return renderSalesSql(null, String(year), String(month));
  const code = String(repCode).trim();
  if (!code) throw new Error("repCode is required");
  return renderSalesSql(`'${code.replace(/'/g, "''")}'`, String(year), String(month));
}

/**
 * Template for the email-schedule path (sql_schedules). `__REPCODE__` is
 * replaced when a schedule is seeded; `{py}` / `{pm}` are replaced at run time
 * by interpolateScheduleTokens with the previous completed month's year and
 * month number. Runs and the in-app test path use buildSalesReportSql.
 */
export const SALES_ANNUALIZED_SQL = renderSalesSql("'__REPCODE__'", "{py}", "{pm}");

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Replace `{cy}`, `{Mon}`, `{py}`, `{pm}` tokens in any SQL text.
 * `{Mon}` / `{pm}` are the PREVIOUS completed calendar month relative to `now`;
 * `{py}` is that month's year. Strings without tokens are returned unchanged.
 */
export function interpolateScheduleTokens(sql: string, now: Date = new Date()): string {
  if (!/\{(cy|Mon|py|pm)\}/.test(sql)) return sql;
  // Anchor to the Central calendar date: the P21 server's GETDATE() is Central wall-clock.
  const [cyNum, mNum] = dateStrInTz(now, CENTRAL_TZ).split("-").map(Number);
  const prevIdx = mNum === 1 ? 11 : mNum - 2;
  const py = mNum === 1 ? cyNum - 1 : cyNum;
  return sql
    .replace(/\{cy\}/g, String(cyNum))
    .replace(/\{Mon\}/g, SHORT_MONTHS[prevIdx])
    .replace(/\{py\}/g, String(py))
    .replace(/\{pm\}/g, String(prevIdx + 1));
}

/**
 * Rep discovery from Kevin's ship-to master (current rep on each ship-to).
 * No email here: P21 salesrep IDs and contact IDs are different key spaces,
 * so emails are matched by NAME against P21_CONTACTS_SQL (rep-contact-match.ts).
 */
export const REP_DISCOVERY_SQL = `SELECT m.SalesRepID AS rep_code, MAX(m.SalesRepName) AS rep_name, CAST(NULL AS varchar(255)) AS rep_email
FROM ${DB}.vwShipToMaster m
WHERE m.SalesRepID IS NOT NULL AND LTRIM(RTRIM(m.SalesRepID)) <> ''
GROUP BY m.SalesRepID
ORDER BY rep_name`;

export const REP_DISCOVERY_SQL_NO_EMAIL = REP_DISCOVERY_SQL;

/** All P21 contacts, for name matching to sales reps (read-only). */
export const P21_CONTACTS_SQL = `SELECT CAST(id AS varchar(32)) AS id, first_name, last_name, LTRIM(RTRIM(ISNULL(email_address,''))) AS email, delete_flag
FROM P21.dbo.contacts`;

/** Classification codes that are exempt from keep-level thresholds. */
export const KEEP_LEVEL_EXEMPT = ["ISG", "OP", "MML1", "MML3", "L5", "E2G", "EMPLOYEE"] as const;

/**
 * Annual sales required to keep each price level. The run reads the same
 * figures from vwCustomerPricing.TargetSales (checked 2026-09-30: identical,
 * L5 = 0). Kept for UI fallbacks on rows without a stored threshold.
 */
export const KEEP_LEVEL_THRESHOLDS: Record<string, number> = {
  L1: 450000,
  L2: 200000,
  L3: 100000,
  L4: 25000,
};

/** Workbook column order, matching the original Upshaw reports. */
export function workbookHeaders(year: number, monthLabel: string): string[] {
  return [
    "Cust Code", "Price", "BG", "Customer Name", "City", "St",
    "Total Value", "Year 2022", "Year 2023", "Year 2024", "Year 2025",
    `Year ${year}`, `Ann ${year}`, "Pct",
    `${monthLabel} Sales`, `${monthLabel} Profit`, "Keep Lvl",
  ];
}

export const SHORT_MONTH_NAMES = SHORT_MONTHS;
