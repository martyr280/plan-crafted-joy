// READ-ONLY (sql.select): Aug 2026 lines in groups 95/9908/9910/9911 that candidate_v1 kept and the new build drops,
// attributed with the same rep rule. Writes only /tmp/sr/excl.json.
import { runJob } from "../src/lib/p21.server";
import { writeFileSync } from "fs";
const SQL = `WITH O AS (SELECT order_number, MIN(salesrep_id) mn FROM P21.dbo.oe_hdr_salesrep GROUP BY order_number) SELECT ISNULL(O.mn,h.salesrep_id) rep, h.customer_id, il.product_group_id grp, SUM(il.extended_price) ep, SUM(CASE WHEN MONTH(h.invoice_date)=8 THEN il.extended_price ELSE 0 END) aug, COUNT(*) n FROM P21.dbo.invoice_hdr h JOIN P21.dbo.invoice_line il ON il.invoice_no=h.invoice_no LEFT JOIN O ON O.order_number=h.order_no WHERE h.invoice_date>='2026-01-01' AND h.invoice_date<'2026-09-01' AND il.product_group_id IN ('95','9908','9910','9911') AND il.item_id<>'999999' AND NOT EXISTS (SELECT 1 FROM P21.dbo.invoice_line c WHERE c.invoice_no=il.invoice_no AND c.invoice_line_uid_parent=il.invoice_line_uid) GROUP BY ISNULL(O.mn,h.salesrep_id), h.customer_id, il.product_group_id`;
const { result }: any = await runJob("sql.select", { sql: SQL, maxRows: 50000 }, 240000);
writeFileSync("/tmp/sr/excl.json", JSON.stringify(result.rows));
console.log("rows", result.rows.length, "truncated", result.truncated);
