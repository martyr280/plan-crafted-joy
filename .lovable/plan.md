## Goal

Reproduce the five attached workbooks (Hector/Mark/Olivia/Michelle/Nikki "Sales 2022–2026 Annualized May") as automated scheduled queries delivered by email. One schedule per rep, same column layout, same sort order, dynamic for "previous completed month".

## Report shape (matches the xlsx exactly)

Columns, in order:

1. `Cust Code` — customer_id
2. `Price` — customer price level (L1/L3/MML1/MML3/L5/…)
3. `BG` — business group (ISG, OP, MML1, MML3, N, …)
4. `Customer Name`
5. `City`
6. `St`
7. `Total Value` — lifetime invoiced net sales (all years in source)
8. `Year 2022` … `Year {currentYear}` — calendar-year net sales
9. `Ann {currentYear}` — current-YTD × (365 / days elapsed YTD)
10. `Pct` — `(Ann {currentYear} - Year {currentYear-1}) / Year {currentYear-1}`; null when prior year is 0
11. `{Mon} Sales` — previous completed calendar month net sales, header renamed (Jun, Jul, …)
12. `{Mon} Profit` — previous completed calendar month gross profit
13. `Keep Lvl` — `CASE WHEN BG IN ('ISG','OP','MML1','MML3','L5') THEN BG ELSE <threshold for price level> END`

Sort: `{Mon} Sales DESC`, then `Ann {currentYear} DESC`.

Threshold table for Keep Lvl when BG is not a group (derived from the files; confirm before seeding):

| Price level | Threshold |
| --- | --- |
| L1 | 450000 |
| L2 | ~200000 |
| L3 | 75000–100000 (varies by file) |
| L4 | 25000 |
| MML1 | (mirrors group label) |
| MML3 | (mirrors group label) |
| L5 | (mirrors group label) |

I'll lock the exact numeric thresholds with you before seeding — the xlsx shows a few different values per level.

## Customer scope per rep

"Both: assigned OR historically invoiced" — for `@repCode`, include every `customer_id` where:

- `customer.salesrep_id = @repCode`, OR
- there exists any `invoice_hdr` row 2022-01-01 → today with `salesrep_id = @repCode` for that customer.

## SQL (single statement, parameterized)

One T-SQL `WITH` chain against P21 (`invoice_hdr` + `invoice_line` + `customer`):

```text
DECLARE @repCode varchar(20) = @repCode;
DECLARE @today date = CAST(GETDATE() AS date);
DECLARE @prevMonthStart date = DATEADD(month, DATEDIFF(month, 0, @today) - 1, 0);
DECLARE @prevMonthEnd   date = DATEADD(month, DATEDIFF(month, 0, @today),     0);  -- exclusive
DECLARE @yrStart        date = DATEFROMPARTS(YEAR(@today), 1, 1);
DECLARE @daysElapsed    int  = DATEDIFF(day, @yrStart, @today) + 1;

WITH scope AS (
  SELECT DISTINCT customer_id
  FROM invoice_hdr
  WHERE salesrep_id = @repCode AND invoice_date >= '2022-01-01'
  UNION
  SELECT customer_id FROM customer WHERE salesrep_id = @repCode
),
inv AS (
  SELECT ih.customer_id, ih.invoice_date,
         il.extended_price AS net,
         (il.extended_price - il.extended_cost) AS gp
  FROM invoice_hdr ih
  JOIN invoice_line il ON il.invoice_no = ih.invoice_no
  WHERE ih.customer_id IN (SELECT customer_id FROM scope)
)
SELECT
  c.customer_id          AS [Cust Code],
  c.price_level          AS [Price],
  c.business_group       AS [BG],
  c.customer_name        AS [Customer Name],
  c.city                 AS [City],
  c.state                AS [St],
  SUM(inv.net)           AS [Total Value],
  SUM(CASE WHEN YEAR(invoice_date)=2022 THEN net END) AS [Year 2022],
  SUM(CASE WHEN YEAR(invoice_date)=2023 THEN net END) AS [Year 2023],
  SUM(CASE WHEN YEAR(invoice_date)=2024 THEN net END) AS [Year 2024],
  SUM(CASE WHEN YEAR(invoice_date)=2025 THEN net END) AS [Year 2025],
  SUM(CASE WHEN YEAR(invoice_date)=YEAR(@today) THEN net END) AS [Year {cy}],
  SUM(CASE WHEN YEAR(invoice_date)=YEAR(@today) THEN net END)
      * 365.0 / @daysElapsed                                 AS [Ann {cy}],
  -- Pct vs prior year
  (Ann - PrevYear)/NULLIF(PrevYear,0)                        AS [Pct],
  SUM(CASE WHEN invoice_date>=@prevMonthStart AND invoice_date<@prevMonthEnd THEN net END) AS [{Mon} Sales],
  SUM(CASE WHEN invoice_date>=@prevMonthStart AND invoice_date<@prevMonthEnd THEN gp  END) AS [{Mon} Profit],
  CASE WHEN c.business_group IN ('ISG','OP','MML1','MML3','L5')
       THEN c.business_group
       ELSE CAST(<threshold map>(c.price_level) AS varchar(20))
  END                                                        AS [Keep Lvl]
FROM customer c
JOIN inv ON inv.customer_id = c.customer_id
GROUP BY c.customer_id, c.price_level, c.business_group, c.customer_name, c.city, c.state
ORDER BY [{Mon} Sales] DESC, [Ann {cy}] DESC;
```

Notes:
- Column-name interpolation (`{Mon}`, `{cy}`) happens server-side in `sql-schedules.server.ts` before the SQL is sent to the agent so the xlsx headers read "Jun Sales" / "Jun Profit" / "Year 2026" / "Ann 2026" dynamically. The existing `resolveOutputColumns` already preserves column order in the workbook.
- Exact P21 column names (`salesrep_id`, `price_level`, `business_group`, `extended_cost`) will be confirmed against the live schema before seeding; the structure above is the canonical P21 layout used elsewhere in this codebase (`agent/handlers/sales-query.js`).

## Schedule per rep

Insert five rows into `sql_schedules`, each with:

- `name`: "{RepName} Sales Annualized"
- `sql`: the template above with `@repCode` filled in
- `params`: `{ "repCode": "<P21 code>" }` (kept for documentation; SQL inlines it)
- `recipients`: `["<rep email>"]`
- `bcc_recipients`: `["marty@resolvedynamics.com"]` (matches the existing E2G BCC pattern)
- `email_subject`: `"{RepName} Sales — {{date}}"`
- `schedule_cron`: 1st of each month, 6 AM CT (`0 6 1 * *`), TZ `America/Chicago` — confirm cadence
- `action`: `email`

## What I still need from you before seeding

1. **Reps + P21 codes + emails** (Hector, Mark, Olivia, Michelle, Nikki). The earlier prompt asked but came back empty.
2. **Cadence**: monthly on the 1st at 6 AM Central, OK? Or weekly?
3. **Keep Lvl thresholds**: confirm the numeric defaults per price level (L1=450k, L2=200k, L3=100k, L4=25k) — I'll back-test against the five files before seeding.

## Build phases

1. Add a "Rep Sales Annualized" template button on `/sql-schedules` that pre-fills the SQL and params for a new schedule (rep code + email entered in the form).
2. Extend `sql-schedules.server.ts` to interpolate `{Mon}` / `{cy}` in column aliases at render time so workbook headers track the run date.
3. Verify against the five attached xlsx: run the template with each rep code for May 2026, diff `[Total Value]`, yearly columns, `[May Sales]`, and `[May Profit]` against the files. Fix any column-name mismatches against the live P21 schema.
4. Insert the five `sql_schedules` rows once you confirm reps/emails/thresholds.
5. QA: trigger one schedule manually via the "Run now" action on `/sql-schedules`, confirm the xlsx attachment matches.

## Risks

- Real P21 column names may differ from the canonical names above (e.g. `salesrep_id` vs `salesperson_id`, `business_group` vs `customer_class`); phase 3 catches this before seeding.
- "Total Value" in the files is lifetime through May; if you want it pinned to a 2022-onward window for consistency, say so and I'll add a floor.
- The cron parser already in `sql-schedules.server.ts` handles standard 5-field expressions, so monthly-on-the-1st works without code changes.