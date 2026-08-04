// Template SQL + helpers for the per-rep "Sales Annualized" scheduled report.
// Reproduces the layout of the Olivia/Mark/Hector/Michelle/Nikki workbooks.
//
// Tokens replaced at run time (in both preview and execute paths):
//   {cy}        -> 4-digit current year, e.g. 2026
//   {Mon}       -> short month name of the PREVIOUS completed calendar month,
//                  e.g. "May" when run in June.
//
// The literal token __REPCODE__ is left in the template body; the schedule
// author replaces it with the rep's salesrep id (= contacts.id) when creating
// the row.
//
// Keep this as a single WITH/SELECT statement. Some deployed P21 bridge agents
// still enforce an older "SELECT or WITH only" guard and reject DECLARE batches.
//
// ─── VERIFIED SCHEMA (Kevin, NDI P21 admin — 2026-08-03) ────────────────────
//  * dbo.customer HAS salesrep_id, customer_name.
//    It does NOT have price1, class_id1, mail_city, mail_state.
//  * dbo.invoice_line has NO extended_cost. Cost columns are cogs_amount
//    (decimal 19,4), sales_cost, commission_cost, other_cost. It has
//    invoice_no, order_no (varchar 8), item_id, item_desc, extended_price,
//    inv_mast_uid, qty_shipped, line_no, product_group_id.
//  * There is no usable dbo.salesrep. Reps are contacts. The primary rep for an
//    order resolves via oe_hdr_salesrep (order_number = oe_hdr.order_no,
//    primary_salesrep = 'Y') -> contacts.id.
//  * oe_hdr has ship2_city / ship2_state / ship2_zip, shipping_route_uid,
//    carrier_id, freight_code_uid.
// ────────────────────────────────────────────────────────────────────────────

export const SALES_ANNUALIZED_SQL = `WITH ctx AS (
  SELECT
    CAST('__REPCODE__' AS varchar(20)) AS rep_code,
    CAST(GETDATE() AS date) AS today,
    DATEADD(month, DATEDIFF(month, 0, GETDATE()) - 1, 0) AS prev_month_start,
    DATEADD(month, DATEDIFF(month, 0, GETDATE()),     0) AS prev_month_end,
    YEAR(GETDATE()) AS cy,
    DATEFROMPARTS(YEAR(GETDATE()), 1, 1) AS yr_start,
    DATEDIFF(day, DATEFROMPARTS(YEAR(GETDATE()), 1, 1), CAST(GETDATE() AS date)) + 1 AS days_elapsed
),
scope AS (
  -- Secondary scope source: customer-level default rep assignment.
  SELECT c.customer_id
  FROM dbo.customer c
  CROSS JOIN ctx
  WHERE c.salesrep_id = ctx.rep_code
  UNION
  -- Primary scope source: orders where this rep is the primary salesrep.
  SELECT DISTINCT h.customer_id
  FROM dbo.oe_hdr h
  JOIN dbo.oe_hdr_salesrep hs
    ON hs.order_number = h.order_no
   AND hs.primary_salesrep = 'Y'
  CROSS JOIN ctx
  WHERE hs.salesrep_id = ctx.rep_code
    AND h.order_date >= '2022-01-01'
),
inv AS (
  -- Attribution: invoice_line.order_no -> oe_hdr -> oe_hdr_salesrep (primary).
  -- Orders that carry no primary-salesrep row fall back to the customer's
  -- default rep on dbo.customer.salesrep_id.
  SELECT
    ih.customer_id,
    ih.invoice_date,
    il.extended_price AS net,
    -- >>> PROFIT BASIS — SINGLE POINT OF CHANGE <<<
    -- invoice_line has no extended_cost at NDI. cogs_amount is used here.
    -- TODO(go-live): reconcile cogs_amount vs sales_cost against ONE month of
    -- Joseph's actual workbook numbers before trusting the profit column.
    (il.extended_price - ISNULL(il.cogs_amount, 0)) AS gp
  FROM dbo.invoice_hdr ih
  JOIN dbo.invoice_line il ON il.invoice_no = ih.invoice_no
  LEFT JOIN dbo.oe_hdr h ON h.order_no = il.order_no
  LEFT JOIN dbo.oe_hdr_salesrep hs
    ON hs.order_number = h.order_no
   AND hs.primary_salesrep = 'Y'
  LEFT JOIN dbo.customer c2 ON c2.customer_id = ih.customer_id
  CROSS JOIN ctx
  WHERE ih.invoice_date >= '2022-01-01'
    AND ih.customer_id IN (SELECT customer_id FROM scope)
    AND (
      hs.salesrep_id = ctx.rep_code
      OR (hs.salesrep_id IS NULL AND c2.salesrep_id = ctx.rep_code)
    )
),
geo AS (
  -- Interim City/St source: most-frequent ship-to on the customer's orders.
  -- TODO: replace if NDI exposes a customer-level address source.
  SELECT customer_id, ship_city, ship_state
  FROM (
    SELECT
      h.customer_id,
      h.ship2_city  AS ship_city,
      h.ship2_state AS ship_state,
      ROW_NUMBER() OVER (PARTITION BY h.customer_id ORDER BY COUNT(*) DESC) AS rn
    FROM dbo.oe_hdr h
    WHERE h.order_date >= '2022-01-01'
    GROUP BY h.customer_id, h.ship2_city, h.ship2_state
  ) g
  WHERE g.rn = 1
),
agg AS (
  SELECT
    customer_id,
    SUM(net)                                                              AS total_value,
    SUM(CASE WHEN YEAR(invoice_date)=2022   THEN net END)                 AS y2022,
    SUM(CASE WHEN YEAR(invoice_date)=2023   THEN net END)                 AS y2023,
    SUM(CASE WHEN YEAR(invoice_date)=2024   THEN net END)                 AS y2024,
    SUM(CASE WHEN YEAR(invoice_date)=2025   THEN net END)                 AS y2025,
    SUM(CASE WHEN YEAR(invoice_date)=ctx.cy    THEN net END)              AS y_cy,
    SUM(CASE WHEN YEAR(invoice_date)=ctx.cy-1  THEN net END)              AS y_py,
    SUM(CASE WHEN invoice_date>=ctx.prev_month_start AND invoice_date<ctx.prev_month_end THEN net END) AS m_sales,
    SUM(CASE WHEN invoice_date>=ctx.prev_month_start AND invoice_date<ctx.prev_month_end THEN gp  END) AS m_profit
  FROM inv
  CROSS JOIN ctx
  GROUP BY customer_id
)
SELECT
  c.customer_id                                                                 AS [Cust Code],
  -- TODO: price level source unidentified at NDI (dbo.customer has no price1).
  -- Probably comes from whatever feeds Joseph's report, NULL until confirmed.
  CAST(NULL AS varchar(20))                                                     AS [Price],
  -- TODO: buying group source unidentified at NDI (no class_id1).
  CAST(NULL AS varchar(20))                                                     AS [BG],
  c.customer_name                                                               AS [Customer Name],
  geo.ship_city                                                                 AS [City],
  geo.ship_state                                                                AS [St],
  agg.total_value                                                               AS [Total Value],
  agg.y2022                                                                     AS [Year 2022],
  agg.y2023                                                                     AS [Year 2023],
  agg.y2024                                                                     AS [Year 2024],
  agg.y2025                                                                     AS [Year 2025],
  agg.y_cy                                                                      AS [Year {cy}],
  CAST(agg.y_cy * 365.0 / NULLIF(ctx.days_elapsed, 0) AS decimal(18,2))         AS [Ann {cy}],
  CASE WHEN agg.y_py IS NULL OR agg.y_py = 0 THEN NULL
       ELSE CAST((agg.y_cy * 365.0 / NULLIF(ctx.days_elapsed, 0) - agg.y_py) / agg.y_py AS decimal(18,4))
  END                                                                           AS [Pct],
  agg.m_sales                                                                   AS [{Mon} Sales],
  agg.m_profit                                                                  AS [{Mon} Profit],
  -- TODO: keep-level depends on the price-level mapping above, NULL until then.
  CAST(NULL AS varchar(20))                                                     AS [Keep Lvl]
FROM dbo.customer c
JOIN agg ON agg.customer_id = c.customer_id
LEFT JOIN geo ON geo.customer_id = c.customer_id
CROSS JOIN ctx
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

/**
 * Rep discovery. VERIFIED 2026-08-03: NDI has no usable dbo.salesrep — reps are
 * contacts, discovered through the distinct salesrep ids used on
 * oe_hdr_salesrep and resolved to dbo.contacts by contacts.id.
 *
 * NDI has 51 reps this way, but only 8 have an email populated in P21; the
 * other 43 need manually-entered recipients on their schedule.
 *
 * NOTE: the contacts name/email column names were NOT in Kevin's extract.
 * first_name / last_name / email_address are the standard P21 contacts shape —
 * CONFIRM before go-live and adjust the COALESCE below if this install differs.
 */
export const REP_DISCOVERY_SQL = `
SELECT
  reps.salesrep_id AS rep_code,
  COALESCE(
    NULLIF(LTRIM(RTRIM(ISNULL(ct.first_name, '') + ' ' + ISNULL(ct.last_name, ''))), ''),
    reps.salesrep_id
  ) AS rep_name,
  NULLIF(LTRIM(RTRIM(ISNULL(ct.email_address, ''))), '') AS rep_email
FROM (
  SELECT DISTINCT hs.salesrep_id
  FROM dbo.oe_hdr_salesrep hs
  WHERE hs.salesrep_id IS NOT NULL
    AND LTRIM(RTRIM(hs.salesrep_id)) <> ''
) reps
LEFT JOIN dbo.contacts ct ON ct.id = reps.salesrep_id
ORDER BY rep_name
`;


/** Classification codes that are exempt from keep-level thresholds. */
export const KEEP_LEVEL_EXEMPT = ["ISG", "OP", "MML1", "MML3", "L5", "E2G", "EMPLOYEE"] as const;

/** Annual sales required to keep each price level. */
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
