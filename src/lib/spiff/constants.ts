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

// Canonical line-detail query — exactly the SSMS query accounting runs today,
// with product_group_id derived from dbo.inv_loc (it does NOT exist on
// dbo.inv_mast in this P21 database). Grouped subquery avoids duplicating
// order lines when an item exists at multiple locations. dateTo is EXCLUSIVE.
export const SPIFF_LINES_SQL = `
SELECT
  b.order_date, b.customer_id, a.order_no, b.po_no, a.inv_mast_uid,
  d.item_id, d.item_desc,
  pg.product_group_id,
  a.qty_ordered, a.unit_price, a.extended_price, a.disposition,
  b.validation_status, e.inv_mast_uid AS kit
FROM dbo.oe_line a
JOIN dbo.oe_hdr b ON a.order_no = b.order_no
JOIN dbo.inv_mast d ON a.inv_mast_uid = d.inv_mast_uid
LEFT JOIN (
  SELECT inv_mast_uid, MAX(product_group_id) AS product_group_id
  FROM dbo.inv_loc
  GROUP BY inv_mast_uid
) pg ON a.inv_mast_uid = pg.inv_mast_uid
LEFT JOIN dbo.assembly_hdr e ON a.inv_mast_uid = e.inv_mast_uid
WHERE b.order_date >= @dateFrom
  AND b.order_date < @dateTo
  AND b.customer_id = @customerId
  AND a.delete_flag = 'N'
  AND a.disposition IS NULL
  AND e.inv_mast_uid IS NULL
ORDER BY b.order_date
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
