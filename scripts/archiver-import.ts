/**
 * One-shot desktop -> web import.
 *   npx tsx scripts/archiver-import.ts <dir> [--remove sender:addr,domain:dom] [--source "label"] [--dry-run]
 * <dir> holds any of: customer-mapping.csv, learned-routing.json, context-rules.json,
 * internal-routes.json, multi-routes.json, mail-notes.json, processed.log, config.json.
 * --dry-run prints the plan counts and writes nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildImportPlan } from "../src/lib/archiver/importer";

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) throw new Error("usage: archiver-import.ts <dir> [--remove sender:x,domain:y] [--source label] [--dry-run]");
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const rd = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
const removeLearned = (flag("--remove") ?? "").split(",").filter(Boolean).map((s) => {
  const [bucket, ...rest] = s.split(":");
  if (bucket !== "sender" && bucket !== "domain") throw new Error(`bad --remove entry '${s}'`);
  return { bucket, key: rest.join(":") } as { bucket: "sender" | "domain"; key: string };
});
const plan = buildImportPlan({
  mappingCsv: rd("customer-mapping.csv"), learnedJson: rd("learned-routing.json"), contextRulesJson: rd("context-rules.json"),
  internalRoutesJson: rd("internal-routes.json"), multiRoutesJson: rd("multi-routes.json"), mailNotesJson: rd("mail-notes.json"),
  ledgerLog: rd("processed.log"), configJson: rd("config.json"),
}, { removeLearned });
console.log(JSON.stringify({ counts: plan.counts, warnings: plan.warnings }, null, 2));
if (args.includes("--dry-run")) process.exit(0);
const { applyImportPlan } = await import("../src/lib/archiver/importer.server");
const counts = await applyImportPlan(plan, { userName: "import script", source: flag("--source") ?? dir, removeLearned });
console.log(JSON.stringify({ applied: counts }, null, 2));
