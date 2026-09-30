import { CENTRAL_TZ, dateStrInTz } from "@/lib/tz";
// Template SQL + helpers for the per-rep "Sales Annualized" report.
// Reproduces the layout of the Upshaw (Olivia/Mark/Hector/Michelle/Nikki) workbooks.
//
// ─── SOURCE (verified through the bridge 2026-09-28) ────────────────────────
// NDI (Kevin) owns the P21 joins in the P21_Analytics_PLAY database, schema
// Sales. The bridge login's default database is P21, so ALWAYS use three-part
// names. Building-block views:
//  * P21_Analytics_PLAY.Sales.vwFactShipToSales — CompanyNo, CustomerID,
//    ShipToID, InvoiceNo, InvoiceDate, SalesYear, SalesMonth, SalesAmount,
//    ProfitAmount, ProductGroup, ProductClass. Already filtered to REGPROD.
//    Sales = extended_price, Profit = extended_price - cogs_amount.
//  * P21_Analytics_PLAY.Sales.vwShipToMaster — CompanyNo, CustomerID, ShipToID,
//    ShipToName, City, State, BuyingGroup, SalesRepID, SalesRepName.
//    The CURRENT rep on the ship-to owns its full sales history.
//  * P21_Analytics_PLAY.Sales.vwCustomerPricing — CompanyNo, CustomerID,
//    PriceLevel, TargetSales.
//
// We do NOT query Kevin's Sales.vwShipToPerformance: it hardcodes May
// (SalesMonth = 5, BETWEEN 1 AND 5, 12.0/5.0, "May Sales"). buildSalesReportSql
// rebuilds its exact logic with period year Y and month M as integer literals.
// Rules kept from Kevin's view:
//  * TotalValue = Sales2022 + Sales2023 + Sales2024 + Sales2025 + SalesYTD
//  * Annualized = SalesYTD * 12.0 / M
//  * Pct = Annualized / Sales2025 - 1 (NULL when Sales2025 = 0)
//    !! FLAG: Pct compares against the FIXED Sales2025 column. Correct for
//    !! Y = 2026 only. For Y = 2027 onward this must become prior-year (Y-1) sales.
//  * Keep Lvl = ISG/OP buying group code, else the SHORTFALL
//    max(0, TargetSales - SalesYTD), else NULL. It is NOT a threshold.
//  * Output column names are FIXED (no month/year in any name); the workbook
//    export regenerates the Upshaw headers from the run's period.
//
// Sales.SalesReportingExclusion exists but is deliberately NOT applied, matching
// Kevin's view. Whether it should be is an open question for NDI.
//
// Keep the SQL single-statement and comment-free: the installed agent (v1.0.0)
// rejects semicolons and `--`, and sanitizeBridgeSql strips them anyway.
// ────────────────────────────────────────────────────────────────────────────

const DB = "P21_Analytics_PLAY.Sales";

/** Render the SQL with already-validated literal fragments. */
function renderSalesSql(repLiteral: string, y: string, m: string): string {
  return `WITH SalesByShipTo AS (
  SELECT
    f.CompanyNo,
    f.CustomerID,
    f.ShipToID,
    SUM(CASE WHEN f.SalesYear = 2022 THEN f.SalesAmount ELSE 0 END) AS Sales2022,
    SUM(CASE WHEN f.SalesYear = 2023 THEN f.SalesAmount ELSE 0 END) AS Sales2023,
    SUM(CASE WHEN f.SalesYear = 2024 THEN f.SalesAmount ELSE 0 END) AS Sales2024,
    SUM(CASE WHEN f.SalesYear = 2025 THEN f.SalesAmount ELSE 0 END) AS Sales2025,
    SUM(CASE WHEN f.SalesYear = ${y} AND f.SalesMonth BETWEEN 1 AND ${m} THEN f.SalesAmount ELSE 0 END) AS SalesYTD,
    SUM(CASE WHEN f.SalesYear = ${y} AND f.SalesMonth = ${m} THEN f.SalesAmount ELSE 0 END) AS MonthSales,
    SUM(CASE WHEN f.SalesYear = ${y} AND f.SalesMonth = ${m} THEN f.ProfitAmount ELSE 0 END) AS MonthProfit
  FROM ${DB}.vwFactShipToSales f
  WHERE f.SalesYear BETWEEN 2022 AND ${y}
  GROUP BY f.CompanyNo, f.CustomerID, f.ShipToID
),
Base AS (
  SELECT
    m.CompanyNo,
    m.CustomerID,
    m.ShipToID,
    m.ShipToName,
    m.City,
    m.State,
    m.BuyingGroup,
    m.SalesRepID,
    m.SalesRepName,
    cp.PriceLevel,
    cp.TargetSales,
    ISNULL(s.Sales2022, 0) AS Sales2022,
    ISNULL(s.Sales2023, 0) AS Sales2023,
    ISNULL(s.Sales2024, 0) AS Sales2024,
    ISNULL(s.Sales2025, 0) AS Sales2025,
    ISNULL(s.SalesYTD, 0) AS SalesYTD,
    ISNULL(s.MonthSales, 0) AS MonthSales,
    ISNULL(s.MonthProfit, 0) AS MonthProfit
  FROM ${DB}.vwShipToMaster m
  LEFT JOIN SalesByShipTo s
    ON s.CompanyNo = m.CompanyNo
   AND s.CustomerID = m.CustomerID
   AND s.ShipToID = m.ShipToID
  LEFT JOIN ${DB}.vwCustomerPricing cp
    ON cp.CompanyNo = m.CompanyNo
   AND cp.CustomerID = m.CustomerID
  WHERE m.SalesRepID = ${repLiteral}
),
Calc AS (
  SELECT
    b.*,
    b.Sales2022 + b.Sales2023 + b.Sales2024 + b.Sales2025 + b.SalesYTD AS TotalValue,
    b.SalesYTD * 12.0 / ${m} AS Annualized
  FROM Base b
)
SELECT
  c.ShipToID AS [Cust Code],
  c.PriceLevel AS [Price],
  CASE WHEN c.BuyingGroup IS NULL THEN 'N' ELSE c.BuyingGroup END AS [BG],
  c.ShipToName AS [Customer Name],
  c.City AS [City],
  c.State AS [St],
  CAST(c.TotalValue AS decimal(19,2)) AS [Total Value],
  CAST(c.Sales2022 AS decimal(19,2)) AS [Year 2022],
  CAST(c.Sales2023 AS decimal(19,2)) AS [Year 2023],
  CAST(c.Sales2024 AS decimal(19,2)) AS [Year 2024],
  CAST(c.Sales2025 AS decimal(19,2)) AS [Year 2025],
  CAST(c.SalesYTD AS decimal(19,2)) AS [Year Current],
  CAST(c.Annualized AS decimal(19,2)) AS [Ann Current],
  CAST(CASE WHEN c.Sales2025 = 0 THEN NULL ELSE c.Annualized / NULLIF(c.Sales2025, 0) - 1 END AS decimal(19,4)) AS [Pct],
  CAST(c.MonthSales AS decimal(19,2)) AS [Month Sales],
  CAST(c.MonthProfit AS decimal(19,2)) AS [Month Profit],
  CASE
    WHEN c.BuyingGroup IN ('ISG', 'OP') THEN c.BuyingGroup
    WHEN c.TargetSales IS NOT NULL THEN CONVERT(varchar(30), CAST(CASE WHEN c.TargetSales - c.SalesYTD < 0 THEN 0 ELSE c.TargetSales - c.SalesYTD END AS decimal(19,2)))
    ELSE NULL
  END AS [Keep Lvl],
  c.CustomerID,
  c.ShipToID,
  c.SalesRepID,
  c.SalesRepName,
  c.BuyingGroup,
  c.PriceLevel,
  c.TargetSales
FROM Calc c
ORDER BY [Total Value] DESC`;
}

export type SalesReportSqlInput = { repCode: string; year: number; month: number };

/** Validated, fully-substituted report SQL for one rep and one period. */
export function buildSalesReportSql({ repCode, year, month }: SalesReportSqlInput): string {
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error(`Invalid year: ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error(`Invalid month: ${month}`);
  const code = String(repCode ?? "").trim();
  if (!code) throw new Error("repCode is required");
  // Pct note: see header — Sales2025 is fixed; for year >= 2027 this must become prior-year sales.
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
 * Annual sales required to keep each price level. NOT used by the report run:
 * the view's Keep Lvl is already the shortfall against vwCustomerPricing.TargetSales.
 * Kept only for legacy UI fallbacks on old runs.
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
