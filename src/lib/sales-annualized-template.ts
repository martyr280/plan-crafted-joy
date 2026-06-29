// Template SQL + helpers for the per-rep "Sales Annualized" scheduled report.
// Reproduces the layout of the Olivia/Mark/Hector/Michelle/Nikki workbooks.
//
// Tokens replaced at run time (in both preview and execute paths):
//   {cy}        -> 4-digit current year, e.g. 2026
//   {Mon}       -> short month name of the PREVIOUS completed calendar month,
//                  e.g. "May" when run in June.
//
// The literal token __REPCODE__ is left in the template body; the schedule
// author replaces it with the rep's P21 salesrep_id when creating the row.
//
// NOTE on P21 column names: this codebase consistently uses customer_id,
// customer_name, salesrep_id, invoice_hdr, invoice_line, extended_price,
// extended_cost. The price-level and business-group columns on dbo.customer
// vary by P21 install; the template uses `price1` and `class_id1`, which are
// the standard P21 customer-classification columns. Verify against the live
// schema before seeding production schedules.

export const SALES_ANNUALIZED_SQL = `DECLARE @repCode varchar(20) = '__REPCODE__';
DECLARE @today date = CAST(GETDATE() AS date);
DECLARE @prevMonthStart date = DATEADD(month, DATEDIFF(month, 0, @today) - 1, 0);
DECLARE @prevMonthEnd   date = DATEADD(month, DATEDIFF(month, 0, @today),     0);
DECLARE @cy int = YEAR(@today);
DECLARE @yrStart date = DATEFROMPARTS(@cy, 1, 1);
DECLARE @daysElapsed int = DATEDIFF(day, @yrStart, @today) + 1;

WITH scope AS (
  SELECT customer_id FROM dbo.customer WHERE salesrep_id = @repCode
  UNION
  SELECT DISTINCT ih.customer_id
  FROM dbo.invoice_hdr ih
  WHERE ih.salesrep_id = @repCode
    AND ih.invoice_date >= '2022-01-01'
),
inv AS (
  SELECT
    ih.customer_id,
    ih.invoice_date,
    il.extended_price AS net,
    (il.extended_price - ISNULL(il.extended_cost, 0)) AS gp
  FROM dbo.invoice_hdr ih
  JOIN dbo.invoice_line il ON il.invoice_no = ih.invoice_no
  WHERE ih.customer_id IN (SELECT customer_id FROM scope)
    AND ih.invoice_date >= '2022-01-01'
),
agg AS (
  SELECT
    customer_id,
    SUM(net)                                                              AS total_value,
    SUM(CASE WHEN YEAR(invoice_date)=2022   THEN net END)                 AS y2022,
    SUM(CASE WHEN YEAR(invoice_date)=2023   THEN net END)                 AS y2023,
    SUM(CASE WHEN YEAR(invoice_date)=2024   THEN net END)                 AS y2024,
    SUM(CASE WHEN YEAR(invoice_date)=2025   THEN net END)                 AS y2025,
    SUM(CASE WHEN YEAR(invoice_date)=@cy    THEN net END)                 AS y_cy,
    SUM(CASE WHEN YEAR(invoice_date)=@cy-1  THEN net END)                 AS y_py,
    SUM(CASE WHEN invoice_date>=@prevMonthStart AND invoice_date<@prevMonthEnd THEN net END) AS m_sales,
    SUM(CASE WHEN invoice_date>=@prevMonthStart AND invoice_date<@prevMonthEnd THEN gp  END) AS m_profit
  FROM inv
  GROUP BY customer_id
)
SELECT
  c.customer_id                                                                 AS [Cust Code],
  c.price1                                                                      AS [Price],
  c.class_id1                                                                   AS [BG],
  c.customer_name                                                               AS [Customer Name],
  c.mail_city                                                                   AS [City],
  c.mail_state                                                                  AS [St],
  agg.total_value                                                               AS [Total Value],
  agg.y2022                                                                     AS [Year 2022],
  agg.y2023                                                                     AS [Year 2023],
  agg.y2024                                                                     AS [Year 2024],
  agg.y2025                                                                     AS [Year 2025],
  agg.y_cy                                                                      AS [Year {cy}],
  CAST(agg.y_cy * 365.0 / NULLIF(@daysElapsed, 0) AS decimal(18,2))             AS [Ann {cy}],
  CASE WHEN agg.y_py IS NULL OR agg.y_py = 0 THEN NULL
       ELSE CAST((agg.y_cy * 365.0 / NULLIF(@daysElapsed, 0) - agg.y_py) / agg.y_py AS decimal(18,4))
  END                                                                           AS [Pct],
  agg.m_sales                                                                   AS [{Mon} Sales],
  agg.m_profit                                                                  AS [{Mon} Profit],
  CASE WHEN c.class_id1 IN ('ISG','OP','MML1','MML3','L5') THEN c.class_id1
       WHEN c.price1 = 'L1'   THEN '450000'
       WHEN c.price1 = 'L2'   THEN '200000'
       WHEN c.price1 = 'L3'   THEN '100000'
       WHEN c.price1 = 'L4'   THEN '25000'
       ELSE NULL
  END                                                                           AS [Keep Lvl]
FROM dbo.customer c
JOIN agg ON agg.customer_id = c.customer_id
ORDER BY agg.m_sales DESC, agg.y_cy DESC;
`;

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Replace `{cy}` and `{Mon}` tokens in any SQL text. `{Mon}` is the short
 * name of the PREVIOUS completed calendar month relative to `now`.
 *
 * Safe to call on every schedule SQL — strings without the tokens are
 * returned unchanged.
 */
export function interpolateScheduleTokens(sql: string, now: Date = new Date()): string {
  if (!sql.includes("{cy}") && !sql.includes("{Mon}")) return sql;
  const cy = now.getUTCFullYear();
  // Previous completed month: subtract 1 from the local month index, wrap.
  const m = now.getMonth();
  const prevIdx = m === 0 ? 11 : m - 1;
  const mon = SHORT_MONTHS[prevIdx];
  return sql.replace(/\{cy\}/g, String(cy)).replace(/\{Mon\}/g, mon);
}
