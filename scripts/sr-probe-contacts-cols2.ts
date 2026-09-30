// READ-ONLY probe. No writes.
import { runJob } from "../src/lib/p21.server";
const q = async (sql: string) => { const r: any = await runJob("sql.select", { sql, maxRows: 500 }, 90000); return r?.rows ?? r?.result?.rows ?? r; };
console.log(await q("SELECT TOP 12 TABLE_NAME, COLUMN_NAME FROM P21.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'contacts' ORDER BY ORDINAL_POSITION"));
console.log(await q("SELECT TABLE_NAME FROM P21.INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%salesrep%'"));
console.log(await q("SELECT COUNT(*) AS n, SUM(CASE WHEN ISNULL(email_address,'')<>'' THEN 1 ELSE 0 END) AS with_email FROM P21.dbo.contacts"));
