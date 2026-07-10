// Product group lists used to scope SPIFF eligibility.
// Edit these in one place when accounting changes the rule.

export const PL_RYKER_JAX_GROUPS = [
  "2570", "2670", "2770", "2870", "2970",
  "3070", "3090", "3110", "3120", "3130", "3190", "3350",
];

export const STOCK_SEATING_GROUPS = [
  "4000", "4010", "4020", "4030", "4040", "4050", "4060", "4070", "4080",
  "4090", "4100", "4110", "4120", "4130", "4140", "4150", "4160",
  "4200", "4300", "4400", "4500", "4600",
  "5000", "5050", "5100", "5220", "5700", "8406",
];

export type ProductScope = "all" | "pl_ryker_jax" | "pl_ryker_jax_no_seating";

export function isInScope(productGroupId: string | null | undefined, scope: ProductScope): boolean {
  const pg = String(productGroupId ?? "").trim();
  if (scope === "all") return true;
  if (scope === "pl_ryker_jax") return PL_RYKER_JAX_GROUPS.includes(pg);
  if (scope === "pl_ryker_jax_no_seating") {
    return PL_RYKER_JAX_GROUPS.includes(pg) && !STOCK_SEATING_GROUPS.includes(pg);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sample / catalog exclusion configuration (Kim K. rules #4 and #5).
// Nothing in the P21 schema identifies these today, so we match by keyword on
// item_id / item_desc plus optional configurable item-ID and product-group
// deny lists. Edit here once the client confirms how samples/catalogs are
// actually coded — the constants flow to SQL nowhere, they're applied in JS
// so tweaks don't require a bridge redeploy.
// ---------------------------------------------------------------------------

export const SAMPLE_KEYWORDS = ["SAMPLE"];
export const CATALOG_KEYWORDS = ["CATALOG", "CATALOGUE"];

// Item IDs the client wants unconditionally excluded (add SKUs here).
export const EXCLUDED_ITEM_IDS: string[] = [];

// Product groups treated as sample/catalog buckets regardless of description.
export const SAMPLE_PRODUCT_GROUPS: string[] = [];
export const CATALOG_PRODUCT_GROUPS: string[] = [];

function containsAny(hay: string, needles: string[]): boolean {
  const s = hay.toUpperCase();
  return needles.some((n) => s.includes(n.toUpperCase()));
}

export type SampleCatalogReason = "sample" | "catalog" | null;

export function classifySampleCatalog(opts: {
  itemId: string | null | undefined;
  itemDesc: string | null | undefined;
  productGroupId: string | null | undefined;
}): SampleCatalogReason {
  const id = String(opts.itemId ?? "").trim();
  const desc = String(opts.itemDesc ?? "").trim();
  const pg = String(opts.productGroupId ?? "").trim();
  const blob = `${id} ${desc}`;
  if (EXCLUDED_ITEM_IDS.includes(id)) return "sample"; // treat manual deny list as samples
  if (pg && SAMPLE_PRODUCT_GROUPS.includes(pg)) return "sample";
  if (pg && CATALOG_PRODUCT_GROUPS.includes(pg)) return "catalog";
  if (containsAny(blob, SAMPLE_KEYWORDS)) return "sample";
  if (containsAny(blob, CATALOG_KEYWORDS)) return "catalog";
  return null;
}

// Machine-readable snapshot of every data-selection rule, persisted with the
// run so the UI + workbook can show exactly what was applied at generation
// time (client feedback: rules must be surfaced and auditable).
export const EXCLUSION_RULES: Array<{ code: string; label: string; where: string }> = [
  {
    code: "invoiced_only",
    label: "Invoiced orders only (uninvoiced order lines excluded)",
    where: "SQL: INNER-equivalent join to invoice_line; JS marks invoiced_qty=0 as not_invoiced",
  },
  {
    code: "no_quotes",
    label: "Quotes excluded",
    where: "SQL: oe_hdr.projected_order = 'N' (also implicit — quotes never invoice)",
  },
  {
    code: "no_cancelled",
    label: "Cancelled orders excluded (header cancel flag or validation_status CANCEL)",
    where: "JS: exclusion_reason='cancelled' (header-level)",
  },
  {
    code: "no_samples",
    label: `Samples excluded (item_id/desc contains ${SAMPLE_KEYWORDS.join("/")})`,
    where: "JS: exclusion_reason='sample'",
  },
  {
    code: "no_catalogs",
    label: `Catalogs excluded (item_id/desc contains ${CATALOG_KEYWORDS.join("/")})`,
    where: "JS: exclusion_reason='catalog'",
  },
];

// Canonical line-detail query — accounting's SSMS query, extended with:
//   * invoice_line join → invoiced_qty / invoiced_amount (Kim K. rule #1: invoiced-only)
//   * projected_order filter → hard-drop quotes (Kim K. rule #2)
//   * oe_hdr.cancel_flag surfaced so JS can mark cancels excluded (Kim K. #3)
// Samples/catalogs (#4/#5) are handled in JS via classifySampleCatalog so
// tweaking the keyword/deny list doesn't require a bridge SQL change.
//
// P21 SCHEMA ASSUMPTIONS (verify against client's DB):
//   * dbo.oe_hdr.projected_order CHAR/NCHAR with 'N'=order, 'Y'=quote
//   * dbo.oe_hdr.cancel_flag     CHAR/NCHAR with 'N'/'Y'
//   * dbo.invoice_line columns: order_no, order_line_no, qty_shipped, extended_price
//   * dbo.invoice_hdr.cancel_flag CHAR/NCHAR with 'N'/'Y' (cancelled invoices ignored)
//   * dbo.oe_line.line_no exists and matches invoice_line.order_line_no
// Quarter assignment stays keyed to oe_hdr.order_date (existing behavior);
// invoice-date basis is an open question flagged to the client.
export const SPIFF_LINES_SQL = `
SELECT
  b.order_date, b.customer_id, a.order_no, a.line_no, b.po_no, a.inv_mast_uid,
  d.item_id, d.item_desc,
  pg.product_group_id,
  a.qty_ordered, a.unit_price, a.extended_price, a.disposition,
  b.validation_status,
  ISNULL(b.cancel_flag, 'N') AS cancel_flag,
  ISNULL(b.projected_order, 'N') AS projected_order,
  e.inv_mast_uid AS kit,
  ISNULL(inv.invoiced_qty, 0) AS invoiced_qty,
  ISNULL(inv.invoiced_amount, 0) AS invoiced_amount
FROM dbo.oe_line a
JOIN dbo.oe_hdr b ON a.order_no = b.order_no
JOIN dbo.inv_mast d ON a.inv_mast_uid = d.inv_mast_uid
LEFT JOIN (
  SELECT inv_mast_uid, MAX(product_group_id) AS product_group_id
  FROM dbo.inv_loc
  GROUP BY inv_mast_uid
) pg ON a.inv_mast_uid = pg.inv_mast_uid
LEFT JOIN dbo.assembly_hdr e ON a.inv_mast_uid = e.inv_mast_uid
LEFT JOIN (
  SELECT il.order_no, il.order_line_no,
         SUM(il.qty_shipped) AS invoiced_qty,
         SUM(il.extended_price) AS invoiced_amount
  FROM dbo.invoice_line il
  JOIN dbo.invoice_hdr ih ON il.invoice_no = ih.invoice_no
  WHERE ISNULL(ih.cancel_flag, 'N') = 'N'
  GROUP BY il.order_no, il.order_line_no
) inv ON inv.order_no = a.order_no AND inv.order_line_no = a.line_no
WHERE b.order_date >= @dateFrom
  AND b.order_date < @dateTo
  AND b.customer_id = @customerId
  AND a.delete_flag = 'N'
  AND a.disposition IS NULL
  AND e.inv_mast_uid IS NULL
  AND ISNULL(b.projected_order, 'N') = 'N'
ORDER BY b.order_date
`.trim();

export const SPIFF_LINES_ALL_SQL = `
SELECT
  b.order_date, b.customer_id, a.order_no, a.line_no, b.po_no, a.inv_mast_uid,
  d.item_id, d.item_desc,
  pg.product_group_id,
  a.qty_ordered, a.unit_price, a.extended_price, a.disposition,
  b.validation_status,
  ISNULL(b.cancel_flag, 'N') AS cancel_flag,
  ISNULL(b.projected_order, 'N') AS projected_order,
  e.inv_mast_uid AS kit,
  ISNULL(inv.invoiced_qty, 0) AS invoiced_qty,
  ISNULL(inv.invoiced_amount, 0) AS invoiced_amount
FROM dbo.oe_line a
JOIN dbo.oe_hdr b ON a.order_no = b.order_no
JOIN dbo.inv_mast d ON a.inv_mast_uid = d.inv_mast_uid
LEFT JOIN (
  SELECT inv_mast_uid, MAX(product_group_id) AS product_group_id
  FROM dbo.inv_loc
  GROUP BY inv_mast_uid
) pg ON a.inv_mast_uid = pg.inv_mast_uid
LEFT JOIN dbo.assembly_hdr e ON a.inv_mast_uid = e.inv_mast_uid
LEFT JOIN (
  SELECT il.order_no, il.order_line_no,
         SUM(il.qty_shipped) AS invoiced_qty,
         SUM(il.extended_price) AS invoiced_amount
  FROM dbo.invoice_line il
  JOIN dbo.invoice_hdr ih ON il.invoice_no = ih.invoice_no
  WHERE ISNULL(ih.cancel_flag, 'N') = 'N'
  GROUP BY il.order_no, il.order_line_no
) inv ON inv.order_no = a.order_no AND inv.order_line_no = a.line_no
WHERE b.order_date >= @dateFrom
  AND b.order_date < @dateTo
  AND b.customer_id IN ({customer_ids})
  AND a.delete_flag = 'N'
  AND a.disposition IS NULL
  AND e.inv_mast_uid IS NULL
  AND ISNULL(b.projected_order, 'N') = 'N'
ORDER BY b.customer_id, b.order_date
`.trim();

// AR aging gate query. If schema guess fails at runtime, we surface
// the error gracefully and flag the run as "aging_unavailable".
export const SPIFF_AGING_SQL = `
SELECT
  customer_id,
  SUM(CASE WHEN DATEDIFF(day, net_due_date, GETDATE()) > 30
           THEN total_amount - amount_paid ELSE 0 END) AS past_due_30
FROM dbo.invoice_hdr
WHERE customer_id IN ({customer_ids})
  AND total_amount > amount_paid
GROUP BY customer_id
`.trim();
