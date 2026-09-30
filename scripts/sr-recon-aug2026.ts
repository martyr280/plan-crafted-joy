// P21 READ-ONLY (sql.select). Writes ONLY to the verification table sales_recon_aug2026 (source='candidate_v1').
import { runJob } from "../src/lib/p21.server";
import { supabaseAdmin } from "../src/integrations/supabase/client.server";

const SQL = `WITH L AS (SELECT h.order_no, h.customer_id, h.salesrep_id inv_rep, h.invoice_date, il.extended_price ep, il.extended_price-il.cogs_amount pr FROM P21.dbo.invoice_hdr h JOIN P21.dbo.invoice_line il ON il.invoice_no=h.invoice_no WHERE h.invoice_date>='2026-01-01' AND h.invoice_date<'2026-09-01' AND il.product_group_id IS NOT NULL AND il.product_group_id NOT IN ('10','50') AND il.item_id<>'999999' AND NOT EXISTS (SELECT 1 FROM P21.dbo.invoice_line c WHERE c.invoice_no=il.invoice_no AND c.invoice_line_uid_parent=il.invoice_line_uid)), O AS (SELECT order_number, MIN(salesrep_id) mn FROM P21.dbo.oe_hdr_salesrep GROUP BY order_number), C AS (SELECT customer_id, MAX(customer_name) customer_name FROM P21.dbo.customer GROUP BY customer_id), G AS (SELECT ISNULL(O.mn,L.inv_rep) rep, L.customer_id, SUM(L.ep) ytd, SUM(CASE WHEN MONTH(L.invoice_date)=8 THEN L.ep ELSE 0 END) aug, SUM(CASE WHEN MONTH(L.invoice_date)=8 THEN L.pr ELSE 0 END) aug_profit FROM L LEFT JOIN O ON O.order_number=L.order_no GROUP BY ISNULL(O.mn,L.inv_rep), L.customer_id) SELECT G.rep, G.customer_id, C.customer_name, G.ytd, G.aug, G.aug_profit FROM G LEFT JOIN C ON C.customer_id=G.customer_id`;

const { count: pre } = await supabaseAdmin.from("sales_recon_aug2026").select("id", { count: "exact", head: true });
if (pre) throw new Error(`table already has ${pre} rows; refusing to double-insert`);
const { result }: any = await runJob("sql.select", { sql: SQL, maxRows: 50000 }, 180000);
const rows: any[] = result?.rows ?? [];
if (result?.truncated) throw new Error("truncated");
const s = (v: any) => (v == null ? null : String(v).trim());
const ins = rows.map((r) => ({
  rep_code: s(r.rep), cust_code: s(r.customer_id), customer_name: s(r.customer_name),
  aug_sales: Number(r.aug), aug_profit: Number(r.aug_profit), ytd_2026: Number(r.ytd), source: "candidate_v1",
}));
for (let i = 0; i < ins.length; i += 500) {
  const { error } = await supabaseAdmin.from("sales_recon_aug2026").insert(ins.slice(i, i + 500));
  if (error) throw error;
}
console.log("bridge rows", rows.length, "inserted", ins.length);
