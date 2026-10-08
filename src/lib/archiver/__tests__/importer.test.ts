import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildImportPlan, noteKeyToLedgerKey } from "../importer";

vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in archiver tests"); }));
const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v452");
const rd = (f: string) => readFileSync(join(FX, f), "utf8");

describe("desktop import plan", () => {
  const files = {
    mappingCsv: rd("customer-mapping.csv"), learnedJson: rd("learned-routing.json"), contextRulesJson: rd("context-rules.json"),
    internalRoutesJson: rd("internal-routes.json"), multiRoutesJson: rd("multi-routes.json"),
    ledgerLog: "# header\n2026-10-07T09:00:00\tmid:<a@x>\tE1\tS1\tTeam Texas & LA & MS\tPC\tu\n2026-10-07T10:00:00\tmid:<a@x>\tE1\tS1\tIgnored\tPC\tu\n",
    mailNotesJson: '{"notes":{"<M1@X>":{"needsReply":true,"note":"call"},"eid:E9":{"done":"true"}}}',
    configJson: '﻿{"confidence_threshold":0.7,"dashboard_port":8788,"content_only_senders":""}',
  };
  it("maps every desktop file to rows with natural keys", () => {
    const p = buildImportPlan(files, { settingsOverride: { content_only_senders: "ndiconnect@ndiof.com" } });
    expect(p.counts).toMatchObject({ teams: 4, internal_routes: 2, multi_routes: 3, ledger: 1, notes: 2 });
    expect(p.counts.learned_senders + p.counts.learned_domains).toBe(p.learned.length);
    expect(p.ledger[0].destination).toBe("Ignored"); // last line wins
    expect(p.notes.map((n) => n.ledger_key).sort()).toEqual(["eid:E9", "mid:<m1@x>"]);
    expect(p.settings).toEqual({ confidence_threshold: 0.7, content_only_senders: "ndiconnect@ndiof.com" });
    expect(p.warnings).toEqual([]);
  });
  it("drops learned entries named for removal", () => {
    const learned = JSON.stringify({ senders: { "ndiconnect@ndiof.com": { customer: "MIDWESTALPAN", count: 27 }, "a@b.com": { customer: "E2G", count: 1 } },
      domains: { "ndiof.com": { customer: "MIDWESTALPAN", count: 100 } } });
    const p = buildImportPlan({ learnedJson: learned }, { removeLearned: [{ bucket: "sender", key: "NDIconnect@ndiof.com" }, { bucket: "domain", key: "ndiof.com" }] });
    expect(p.learned.map((l) => `${l.bucket}:${l.key}:${l.source}`)).toEqual(["sender:a@b.com:legacy"]);
    expect(p.counts.learned_removed).toBe(2);
  });
  it("flags rules that point at a team the mapping does not have", () => {
    const p = buildImportPlan({ mappingCsv: files.mappingCsv, internalRoutesJson: '{"routes":{"x@ndiof.com":{"customer":"NOPE"}}}' });
    expect(p.warnings).toEqual(["internal route x@ndiof.com -> NOPE"]);
  });
  it("normalises note keys to ledger keys", () => {
    expect(noteKeyToLedgerKey("<AbC@x>")).toBe("mid:<abc@x>");
    expect(noteKeyToLedgerKey("eid:1")).toBe("eid:1");
    expect(noteKeyToLedgerKey("2026-10-07T09:00:00|Subject")).toBe("2026-10-07T09:00:00|Subject");
  });
});

import { withoutProtected } from "../importer";
describe("re-import protection", () => {
  it("keeps web-created rules and forgotten learned rows out of a desktop re-import", () => {
    const plan: any = {
      contentRules: [{ id: "r1" }, { id: "r2" }], internalRoutes: [{ address: "JPerry@ndiof.com" }, { address: "x@ndiof.com" }],
      multiRoutes: [{ kind: "domain", value: "dealer.com" }], learned: [{ bucket: "domain", key: "ndiof.com" }, { bucket: "sender", key: "a@b.com" }],
    };
    const r = withoutProtected(plan, { contentRuleIds: ["r2"], internalRouteAddresses: ["jperry@ndiof.com"],
      multiRouteKeys: ["domain|DEALER.com"], forgottenLearned: ["domain|ndiof.com"] });
    expect(r.plan.contentRules).toEqual([{ id: "r1" }]);
    expect(r.plan.internalRoutes).toEqual([{ address: "x@ndiof.com" }]);
    expect(r.plan.multiRoutes).toEqual([]);
    expect(r.plan.learned).toEqual([{ bucket: "sender", key: "a@b.com" }]);
    expect(r.skipped).toEqual({ content_rules: 1, internal_routes: 1, multi_routes: 1, learned: 1 });
  });
});
