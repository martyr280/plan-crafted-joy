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
    // v4.5.3: the 5 Oct copy still held the bad ndiof.com -> Texas domain row; it is never imported.
    expect(p.warnings).toEqual(["learned domain ndiof.com -> TEAMTEXASLAMS not imported - own domain or Microsoft tenant domain; senders there are kept as people"]);
    expect(p.learned.some((l) => l.bucket === "domain" && l.key === "ndiof.com")).toBe(false);
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

import { isBlockedLearnedDomain } from "../importer";
import { IMPORT_NEVER_WRITES } from "../importer.server";
const FX3 = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v453");
const rd3 = (f: string) => readFileSync(join(FX3, f), "utf8");

describe("v4.5.3 import of the 22 Oct 2026 production copy", () => {
  const p = buildImportPlan({
    mappingCsv: rd3("customer-mapping.csv"), learnedJson: rd3("learned-routing.json"), contextRulesJson: rd3("context-rules.json"),
    internalRoutesJson: rd3("internal-routes.json"), multiRoutesJson: rd3("multi-routes.json"), configJson: rd3("config.json"),
  });
  it("maps internal_domains onto own_domains (one setting) and carries ignore_internal_replies", () => {
    expect(p.settings).toMatchObject({ own_domains: "ndiof.com", ignore_internal_replies: true });
    expect(p.settings).not.toHaveProperty("internal_domains");
    expect(p.settings).not.toHaveProperty("mode");
    expect(p.settings).not.toHaveProperty("filing_enabled");
    expect([...IMPORT_NEVER_WRITES]).toEqual(["mode", "filing_enabled"]);
  });
  it("leaves no learned domain row for ndiof.com or any *.onmicrosoft.com; the people stay", () => {
    expect(p.learned.filter((l) => l.bucket === "domain" && (l.key === "ndiof.com" || l.key.endsWith(".onmicrosoft.com")))).toEqual([]);
    expect(p.blockedLearnedDomains).toEqual(["naturalofficefurniturellc.onmicrosoft.com"]);
    expect(p.learned.some((l) => l.key === "brianmarzka@naturalofficefurniturellc.onmicrosoft.com")).toBe(true);
    expect(p.learned.some((l) => l.key === "dlange@ndiof.com")).toBe(true);
    expect(isBlockedLearnedDomain("ndiof.com", ["ndiof.com"])).toBe(true);
    expect(isBlockedLearnedDomain("mail.ndiof.com", ["ndiof.com"])).toBe(true);
    expect(isBlockedLearnedDomain("x.onmicrosoft.com", [])).toBe(true);
    expect(isBlockedLearnedDomain("dealer.com", ["ndiof.com"])).toBe(false);
  });
  it("the two 22 Oct regex rules arrive as regex", () => {
    const byId = new Map(p.contentRules.map((r) => [r.id, r]));
    expect(byId.get("cr_20260908_153706_5726")).toMatchObject({ match: "regex", team_key: "TEAMTEXASLAMS" });
    expect(byId.get("cr_20261022_161500_nn01")).toMatchObject({ match: "regex", team_key: "TEAMFLORIDAEASTC" });
    expect(p.contentRules.filter((r) => r.scope === "sender").length).toBe(4);
  });
  it("warns, without changing the data, about an address in a domain list", () => {
    expect(p.settings.never_context_domains).toBe("quickbooks@notification.intuit.com");
    expect(p.warnings).toContain("never_context_domains: 'quickbooks@notification.intuit.com' is an email address, not a domain - this entry has no effect. Use the domain (e.g. 'notification.intuit.com') or remove it.");
  });
});
