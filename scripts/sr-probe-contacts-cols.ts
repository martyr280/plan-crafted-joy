// READ-ONLY probe: P21 contacts column list via sql.select. No writes.
import { runJob } from "../src/lib/p21.server";
const r: any = await runJob("sql.select", { sql: "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM P21.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN ('contacts','salesrep') ORDER BY TABLE_NAME, ORDINAL_POSITION", maxRows: 500 }, 90000);
const rows = r?.rows ?? r?.result?.rows ?? r;
for (const x of rows) console.log(x.TABLE_NAME, x.COLUMN_NAME, x.DATA_TYPE);
