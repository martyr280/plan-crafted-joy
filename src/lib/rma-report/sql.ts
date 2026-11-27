// Client-safe SQL builders for the RMA Report. Dates must already be validated YYYY-MM-DD literals.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(d: string) {
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new Error(`Invalid date: ${d}`);
}
export function addOneDay(d: string): string {
  assertDate(d);
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
export function buildLinesSql(from: string, toExclusive: string): string {
  assertDate(from); assertDate(toExclusive);
  return `SELECT ih.invoice_no, CONVERT(varchar(10), ih.invoice_date, 23) AS invoice_date, ih.order_no, ih.customer_id, ih.bill2_name AS customer_name, ih.sales_location_id, il.item_id, il.item_desc, im.default_product_group AS product_group_id, pg.product_group_desc, im.manufacturer_name, sr.route_code, ABS(il.qty_shipped) AS qty, ABS(il.extended_price) AS return_sales, ABS(il.cogs_amount) AS return_cost, COALESCE(rr.reason, 'Return to Stock') AS return_reason FROM invoice_hdr ih JOIN invoice_line il ON il.invoice_no = ih.invoice_no JOIN p21_view_oe_line ol ON ol.order_no = il.order_no AND ol.line_no = il.oe_line_number AND ol.item_id = il.item_id JOIN p21_view_rma_receipt_line rl ON rl.oe_line_uid = ol.oe_line_uid LEFT JOIN p21_view_reason rr ON rr.id = rl.reason_adjustment_id LEFT JOIN inv_mast im ON im.inv_mast_uid = il.inv_mast_uid LEFT JOIN product_group pg ON pg.product_group_id = im.default_product_group LEFT JOIN oe_hdr h ON h.order_no = ih.order_no LEFT JOIN shipping_route sr ON sr.shipping_route_uid = h.shipping_route_uid WHERE ih.invoice_date >= '${from}' AND ih.invoice_date < '${toExclusive}'`;
}
export function buildSalesSql(from: string, toExclusive: string): string {
  assertDate(from); assertDate(toExclusive);
  return `SELECT ih.customer_id, MAX(ih.bill2_name) AS customer_name, im.default_product_group AS product_group_id, SUM(ABS(il.extended_price)) AS sales FROM invoice_hdr ih JOIN invoice_line il ON il.invoice_no = ih.invoice_no LEFT JOIN inv_mast im ON im.inv_mast_uid = il.inv_mast_uid WHERE ih.invoice_date >= '${from}' AND ih.invoice_date < '${toExclusive}' AND ih.invoice_type = 'IN' AND il.inv_mast_uid IS NOT NULL AND il.qty_shipped > 0 GROUP BY ih.customer_id, im.default_product_group`;
}
