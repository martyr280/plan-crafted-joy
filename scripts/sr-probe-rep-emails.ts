// READ-ONLY probe: P21 salesperson emails through the bridge (sql.select). No writes to P21.
import { runJob } from "../src/lib/p21.server";
import { REP_DISCOVERY_SQL } from "../src/lib/sales-annualized-template";
const codes = ["4498","1020","4361","5990","1022","5432","4501","5610","5609","5425","5608","4499","4571","4670","1016","4563","4256","4657","4157","3155","5365","1023","5614","6795","5604","5603","5324","5606","5605","1015","5333","6796","4362"];
const res: any = await runJob("sql.select", { sql: REP_DISCOVERY_SQL, maxRows: 5000 }, 90000);
const rows: any[] = res?.rows ?? res?.result?.rows ?? res ?? [];
console.log("total reps from P21:", rows.length, "with email:", rows.filter((r) => r.rep_email).length);
for (const c of codes) { const r = rows.find((x) => String(x.rep_code).trim() === c); console.log(c, "|", r?.rep_name ?? "(not found)", "|", r?.rep_email ?? "NULL"); }
