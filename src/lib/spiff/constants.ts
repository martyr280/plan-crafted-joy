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

// Item IDs the client wants unconditionally excluded as samples.
export const EXCLUDED_ITEM_IDS: string[] = [];

// Confirmed catalog SKUs from AP (Kim K., 7/10/2026). Anything added here is
// treated as a catalog regardless of description keyword match.
export const EXCLUDED_CATALOG_ITEM_IDS: string[] = [
  "ND 2026 CAT D",
  "ND 2026 DIGITAL CATALOG",
];

// Product groups treated as sample/catalog buckets regardless of description.
export const SAMPLE_PRODUCT_GROUPS: string[] = [];
export const CATALOG_PRODUCT_GROUPS: string[] = [];

function containsAny(hay: string, needles: string[]): boolean {
  const s = hay.toUpperCase();
  return needles.some((n) => s.includes(n.toUpperCase()));
}

// Whitespace-delimited token match. Used for standalone "CAT" in item_id
// (e.g. "ND 2026 CAT D") without false-positives on SKUs containing CAT
// inside a word like "CATALYST" or "SCATTER".
function hasToken(hay: string, token: string): boolean {
  const t = token.toUpperCase();
  return String(hay)
    .toUpperCase()
    .split(/\s+/)
    .some((tok) => tok === t);
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
  if (EXCLUDED_CATALOG_ITEM_IDS.includes(id)) return "catalog";
  if (EXCLUDED_ITEM_IDS.includes(id)) return "sample";
  if (pg && SAMPLE_PRODUCT_GROUPS.includes(pg)) return "sample";
  if (pg && CATALOG_PRODUCT_GROUPS.includes(pg)) return "catalog";
  if (containsAny(blob, SAMPLE_KEYWORDS)) return "sample";
  if (containsAny(blob, CATALOG_KEYWORDS)) return "catalog";
  // Standalone "CAT" token in item_id — confirmed catalog naming pattern
  // (e.g. "ND 2026 CAT D"). Description-only "CAT" would be too aggressive.
  if (id && hasToken(id, "CAT")) return "catalog";
  return null;
}

// Machine-readable snapshot of every data-selection rule, persisted with the
// run so the UI + workbook can show exactly what was applied at generation
// time (client feedback: rules must be surfaced and auditable).
export const EXCLUSION_RULES: Array<{ code: string; label: string; where: string }> = [
  {
    code: "quarter_basis_invoice_date",
    label: "Quarter assignment = INVOICE DATE (a line pays in the quarter its invoice_date falls in, regardless of when it was ordered)",
    where: "SQL: inv subquery filters on invoice_hdr.invoice_date IN [dateFrom, dateTo); partial invoicing across quarters sums only the in-window invoices",
  },
  {
    code: "invoiced_only",
    label: "Invoiced amount only (uninvoiced lines retained as included=false / not_invoiced for audit)",
    where: "SQL: invoice_line join windowed on invoice_date; JS marks invoiced_qty=0 as not_invoiced",
  },
  {
    code: "no_quotes",
    label: "Quotes excluded (P21 Quote checkbox — oe_hdr.projected_order='Y')",
    where: "SQL: oe_hdr.projected_order = 'N' (client-corroborated: header-level flag on Order Entry screen)",
  },
  {
    code: "no_cancelled",
    label: "Cancelled orders excluded (P21 Cancelled checkbox — header cancel flag or validation_status CANCEL)",
    where: "JS: exclusion_reason='cancelled' (header-level; client-corroborated)",
  },
  {
    code: "no_samples",
    label: `Samples excluded (item_id/desc contains ${SAMPLE_KEYWORDS.join("/")})`,
    where: "JS: exclusion_reason='sample'",
  },
  {
    code: "no_catalogs",
    label: `Catalogs excluded (item_id/desc contains ${CATALOG_KEYWORDS.join("/")}; standalone CAT token in item_id; confirmed SKU deny list)`,
    where: "JS: exclusion_reason='catalog'",
  },
];

// ---------------------------------------------------------------------------
// P21 schema mapping — resolved AT RUNTIME via INFORMATION_SCHEMA.COLUMNS
// against the client's actual database (see spiff.server.ts → discoverSpiffSchema).
// Historically these queries hard-coded `invoice_line.order_line_no`, but the
// client's P21 build doesn't have that column, so we now resolve each moving
// column by candidate priority and substitute into a SQL TEMPLATE. First
// candidate that exists wins.
// ---------------------------------------------------------------------------
export const INVOICE_LINE_LINKAGE_CANDIDATES = [
  "order_line_no",
  "oe_line_number",
  "order_line_number",
  "line_no",
  "line_number",
] as const;

export const OE_LINE_LINKAGE_CANDIDATES = [
  "line_no",
  "line_number",
  "oe_line_number",
] as const;

export const INVOICED_QTY_CANDIDATES = [
  "qty_shipped",
  "qty_invoiced",
  "qty_billed",
] as const;

export const EXTENDED_PRICE_CANDIDATES = ["extended_price"] as const;

export type SchemaMapping = {
  invoice_line_columns: string[];
  oe_line_columns: string[];
  oe_hdr_columns: string[];
  invoice_hdr_columns: string[];
  invoice_line_linkage: string | null; // null → order-level fallback
  oe_line_linkage: string;              // used for a.<col> projection + join RHS
  invoiced_qty: string;
  extended_price: string;
  linkage_mode: "line_level" | "order_level";
  has_oe_cancel_flag: boolean;
  has_invoice_cancel_flag: boolean;
  has_oe_projected_order: boolean;
};

// P21 SCHEMA ASSUMPTIONS still made (verified at runtime where possible):
//   * dbo.oe_hdr.projected_order CHAR/NCHAR with 'N'=order, 'Y'=quote
//   * dbo.oe_hdr.cancel_flag     CHAR/NCHAR with 'N'/'Y'
//   * dbo.invoice_hdr.invoice_date DATE/DATETIME
//   * dbo.invoice_hdr.cancel_flag CHAR/NCHAR with 'N'/'Y'
//   * dbo.invoice_line.order_no exists (schema discovery verifies)
//   * dbo.invoice_line.invoice_no exists (assumed; no candidate list yet)
//   * dbo.oe_line.<oe_line_linkage> exists (schema discovery verifies)
//   * dbo.oe_line.delete_flag / .disposition / .inv_mast_uid / .qty_ordered /
//     .unit_price / .extended_price exist (unchanged from historical query)
function invHdrCancelPredicate(m: SchemaMapping): string {
  return m.has_invoice_cancel_flag ? "ISNULL(ih.cancel_flag, 'N') = 'N' AND " : "";
}

function buildLinkedInvJoin(m: SchemaMapping): string {
  // Line-level linkage: sum invoice quantities/amounts per (order_no, line).
  return `
LEFT JOIN (
  SELECT il.order_no, il.${m.invoice_line_linkage} AS order_line_no,
         SUM(il.${m.invoiced_qty}) AS invoiced_qty,
         SUM(il.${m.extended_price}) AS invoiced_amount,
         MIN(ih.invoice_date) AS first_invoice_date,
         MAX(ih.invoice_date) AS last_invoice_date
  FROM dbo.invoice_line il
  JOIN dbo.invoice_hdr ih ON il.invoice_no = ih.invoice_no
  WHERE ${invHdrCancelPredicate(m)}ih.invoice_date >= @dateFrom
    AND ih.invoice_date < @dateTo
  GROUP BY il.order_no, il.${m.invoice_line_linkage}
) inv ON inv.order_no = a.order_no AND inv.order_line_no = a.${m.oe_line_linkage}
`.trim();
}

function buildOrderLevelInvJoin(m: SchemaMapping): string {
  // Order-level fallback: any oe_line on an invoiced order counts as invoiced.
  return `
LEFT JOIN (
  SELECT il.order_no,
         MIN(ih.invoice_date) AS first_invoice_date,
         MAX(ih.invoice_date) AS last_invoice_date
  FROM dbo.invoice_line il
  JOIN dbo.invoice_hdr ih ON il.invoice_no = ih.invoice_no
  WHERE ${invHdrCancelPredicate(m)}ih.invoice_date >= @dateFrom
    AND ih.invoice_date < @dateTo
  GROUP BY il.order_no
) inv ON inv.order_no = a.order_no
`.trim();
}

function buildInvProjection(m: SchemaMapping): string {
  if (m.linkage_mode === "order_level") {
    return `
  CASE WHEN inv.order_no IS NULL THEN 0 ELSE a.qty_ordered END AS invoiced_qty,
  CASE WHEN inv.order_no IS NULL THEN 0 ELSE a.${m.extended_price} END AS invoiced_amount,
  inv.first_invoice_date,
  inv.last_invoice_date`;
  }
  return `
  ISNULL(inv.invoiced_qty, 0) AS invoiced_qty,
  ISNULL(inv.invoiced_amount, 0) AS invoiced_amount,
  inv.first_invoice_date,
  inv.last_invoice_date`;
}

function buildInvWindowClause(m: SchemaMapping): string {
  return m.linkage_mode === "order_level"
    ? "inv.order_no IS NOT NULL"
    : "inv.invoiced_qty IS NOT NULL";
}

function buildLinesTemplate(m: SchemaMapping, customerClause: string, orderBy: string): string {
  const cancelProj = m.has_oe_cancel_flag
    ? "ISNULL(b.cancel_flag, 'N') AS cancel_flag,"
    : "CAST('N' AS CHAR(1)) AS cancel_flag,";
  const projectedProj = m.has_oe_projected_order
    ? "ISNULL(b.projected_order, 'N') AS projected_order,"
    : "CAST('N' AS CHAR(1)) AS projected_order,";
  const projectedFilter = m.has_oe_projected_order
    ? "AND ISNULL(b.projected_order, 'N') = 'N'"
    : "";
  return `
SELECT
  b.order_date, b.customer_id, a.order_no, a.${m.oe_line_linkage} AS line_no, b.po_no, a.inv_mast_uid,
  d.item_id, d.item_desc,
  pg.product_group_id,
  a.qty_ordered, a.unit_price, a.${m.extended_price} AS extended_price, a.disposition,
  b.validation_status,
  ${cancelProj}
  ${projectedProj}
  e.inv_mast_uid AS kit,${buildInvProjection(m)}
FROM dbo.oe_line a
JOIN dbo.oe_hdr b ON a.order_no = b.order_no
JOIN dbo.inv_mast d ON a.inv_mast_uid = d.inv_mast_uid
LEFT JOIN (
  SELECT inv_mast_uid, MAX(product_group_id) AS product_group_id
  FROM dbo.inv_loc
  GROUP BY inv_mast_uid
) pg ON a.inv_mast_uid = pg.inv_mast_uid
LEFT JOIN dbo.assembly_hdr e ON a.inv_mast_uid = e.inv_mast_uid
${m.linkage_mode === "order_level" ? buildOrderLevelInvJoin(m) : buildLinkedInvJoin(m)}
WHERE ${customerClause}
  AND a.delete_flag = 'N'
  AND a.disposition IS NULL
  AND e.inv_mast_uid IS NULL
  ${projectedFilter}
  AND (
    ${buildInvWindowClause(m)}
    OR (b.order_date >= @dateFrom AND b.order_date < @dateTo)
  )
ORDER BY ${orderBy}
`.trim();
}

export function buildSpiffLinesSql(m: SchemaMapping): string {
  return buildLinesTemplate(m, "b.customer_id = @customerId", "COALESCE(inv.last_invoice_date, b.order_date)");
}

export function buildSpiffLinesAllSql(m: SchemaMapping): string {
  return buildLinesTemplate(
    m,
    "b.customer_id IN ({customer_ids})",
    "b.customer_id, COALESCE(inv.last_invoice_date, b.order_date)",
  );
}

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
