// READ-ONLY: P21 reps + contacts via sql.select; name match; prints table. No writes anywhere.
import { runJob } from "../src/lib/p21.server";
import { REP_DISCOVERY_SQL } from "../src/lib/sales-annualized-template";
import { fetchP21Contacts } from "../src/lib/sales-reports.server";
import { matchRep } from "../src/lib/rep-contact-match";
const codes = ["4498","1020","4361","5990","1022","5432","4501","5610","5609","5425","5608","4499","4571","4670","1016","4563","4256","4657","4157","3155","5365","1023","5614","6795","5604","5603","5324","5606","5605","1015","5333","6796","4362"];
const r: any = await runJob("sql.select", { sql: REP_DISCOVERY_SQL, maxRows: 5000 }, 90000);
const reps: any[] = r?.rows ?? r?.result?.rows ?? [];
const contacts = await fetchP21Contacts(90000);
console.log("contacts:", contacts.length);
const fmt = (c: any) => `${c.id}:${(c.first_name??"").trim()} ${(c.last_name??"").trim()}<${c.email??""}>${c.delete_flag==="Y"?"[deleted]":""}`;
for (const code of codes) {
  const rep = reps.find((x) => String(x.rep_code).trim() === code);
  const m = matchRep(rep?.rep_name ?? null, contacts);
  const c = m.kind === "match" ? m.contact : null;
  console.log([code, rep?.rep_name ?? "(not in P21)", c ? `${c.first_name} ${c.last_name}`.trim() : "-", c?.email ?? "-", c ? (c.delete_flag==="Y"?"no":"yes") : "-", m.kind === "match" ? m.how : m.kind, m.candidates.length && m.kind !== "match" || m.candidates.length > 1 ? m.candidates.map(fmt).join("; ") : "", c?.id ?? ""].join(" | "));
}
