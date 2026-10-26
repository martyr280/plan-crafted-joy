import { readFileSync } from "node:fs";
import { createSweepStore } from "@/lib/archiver/sweep-store.server";
import { buildClassifyConfig, classify, type Knowledge } from "@/lib/archiver/classify";
import { parseContextRules, parseInternalRoutes, parseLearned, parseMappingCsv, parseMultiRoutes } from "@/lib/archiver/import-desktop";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const F = "src/lib/archiver/__tests__/fixtures/";
const rd = (f: string) => readFileSync(F + f, "utf8");
const routes: Record<string, string> = {};
for (const r of parseInternalRoutes(rd("v453/internal-routes.json"))) routes[r.address] = r.customer;
const fileK: Knowledge = { mapping: parseMappingCsv(rd("v453/customer-mapping.csv")), learned: parseLearned(rd("v453/learned-routing.json")),
  ctxRules: parseContextRules(rd("v453/context-rules.json")), internalRoutes: routes, multiRoutes: parseMultiRoutes(rd("v453/multi-routes.json")) };
const store: any = createSweepStore();
const dbK: Knowledge = await store.loadKnowledge();
const { data: st } = await (supabaseAdmin as any).from("app_settings").select("value").eq("key", "archiver").single();
const cfg = buildClassifyConfig(st.value);
const cands = [...JSON.parse(rd("v452/golden.json")).candidates, ...JSON.parse(rd("v453/cases.json"))];
let same = 0; const diff: any[] = [];
for (const c of cands) {
  const x = { id: c.EntryID, senderAddress: c.SenderAddress ?? "", senderName: c.SenderName ?? "", subject: c.Subject ?? "",
    receivedAt: c.ReceivedTime, body: c.Body ?? "", attachmentNames: c.AttachmentNames ?? [] };
  const a = classify(x, fileK, cfg), b = classify(x, dbK, cfg);
  const k = (d: any) => JSON.stringify([d.customerKey, d.confidence, d.matchSource, d.evidence, d.ruleId, d.alsoCustomers, d.destinationRelPath]);
  if (k(a) === k(b)) same++; else diff.push({ id: c.EntryID, file: k(a), db: k(b) });
}
console.log(JSON.stringify({ cases: cands.length, same, diff, cfg: { internalDomains: cfg.internalDomains, ignoreInternalReplies: cfg.ignoreInternalReplies } }, null, 1));
