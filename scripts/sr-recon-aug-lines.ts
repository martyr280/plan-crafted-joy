// READ-ONLY: pulls candidate_v1 August 2026 invoice lines from P21 via sql.select. Writes only /tmp/sr/auglines.json.
import { runJob } from "../src/lib/p21.server";
import { writeFileSync, mkdirSync } from "fs";
const SQL = `WITH O AS (SELECT order_number, MIN(salesrep_id) mn FROM P21.dbo.oe_hdr_salesrep GROUP BY order_number) SELECT ISNULL(O.mn,h.salesrep_id) rep, O.mn order_rep, h.salesrep_id inv_rep, h.customer_id, h.invoice_no, h.invoice_date, il.item_id, il.item_desc, il.product_group_id, il.extended_price, il.cogs_amount, im.other_charge_item, h.invoice_adjustment_type FROM P21.dbo.invoice_hdr h JOIN P21.dbo.invoice_line il ON il.invoice_no=h.invoice_no LEFT JOIN P21.dbo.inv_mast im ON im.inv_mast_uid=il.inv_mast_uid LEFT JOIN O ON O.order_number=h.order_no WHERE h.invoice_date>='2026-08-01' AND h.invoice_date<'2026-09-01' AND il.product_group_id IS NOT NULL AND il.product_group_id NOT IN ('10','50') AND il.item_id<>'999999' AND NOT EXISTS (SELECT 1 FROM P21.dbo.invoice_line c WHERE c.invoice_no=il.invoice_no AND c.invoice_line_uid_parent=il.invoice_line_uid)`;
const { result }: any = await runJob("sql.select", { sql: SQL, maxRows: 50000 }, 240000);
mkdirSync("/tmp/sr", { recursive: true });
writeFileSync("/tmp/sr/auglines.json", JSON.stringify(result.rows));
console.log("rows", result.rows.length, "truncated", result.truncated);
