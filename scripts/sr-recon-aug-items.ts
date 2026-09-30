// READ-ONLY sql.select: current product group per item for the 99xx/95/9 August items. Writes /tmp/sr/itempg.json only.
import { runJob } from "../src/lib/p21.server";
import { readFileSync, writeFileSync } from "fs";
const ids = readFileSync("/tmp/sr/items.txt","utf8").trim();
const SQL = `SELECT im.item_id, il.location_id, il.product_group_id, pg.product_group_desc FROM P21.dbo.inv_mast im JOIN P21.dbo.inv_loc il ON il.inv_mast_uid=im.inv_mast_uid LEFT JOIN P21.dbo.product_group pg ON pg.product_group_id=il.product_group_id AND pg.company_id=il.company_id WHERE im.item_id IN (${ids})`;
const { result }: any = await runJob("sql.select", { sql: SQL, maxRows: 50000 }, 180000);
writeFileSync("/tmp/sr/itempg.json", JSON.stringify(result.rows)); console.log(result.rows.length);
const S2 = `SELECT product_group_id, MAX(product_group_desc) d FROM P21.dbo.product_group WHERE product_group_id LIKE '99%' OR product_group_id IN ('9','95','10','50') GROUP BY product_group_id`;
const r2: any = await runJob("sql.select", { sql: S2 }, 60000); console.log(JSON.stringify(r2.result.rows));
