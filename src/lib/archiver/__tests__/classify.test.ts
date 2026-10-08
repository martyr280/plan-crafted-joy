import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildClassifyConfig, classify, getBodyOriginators, newFileStem, promoteLearnedDomains, roundHalfEven,
  testContextRule, updateLearnedFromResults, isExcluded, type Knowledge,
} from "../classify";
import {
  parseContextRules, parseInternalRoutes, parseLearned, parseLedger, parseMappingCsv, parseMultiRoutes, ledgerKey,
  parseMailNotes, pickImportedSettings,
} from "../import-desktop";

// Pure module: no network. Fail loudly if anything tries.
vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in archiver tests"); }));

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v452");
const rd = (f: string) => readFileSync(join(FX, f), "utf8");

function knowledge(): Knowledge {
  const routes: Record<string, string> = {};
  for (const r of parseInternalRoutes(rd("internal-routes.json"))) routes[r.address] = r.customer;
  return {
    mapping: parseMappingCsv(rd("customer-mapping.csv")),
    learned: parseLearned(rd("learned-routing.json")),
    ctxRules: parseContextRules(rd("context-rules.json")),
    internalRoutes: routes,
    multiRoutes: parseMultiRoutes(rd("multi-routes.json")),
  };
}

/** Ambiguity text names the top two votes; PowerShell orders equal scores by hashtable order. */
function sameAmbiguity(a: string, b: string): boolean {
  if (a === b) return true;
  const rx = /^content names both (.+?) \((.*?)\) and (.+?) \((.*?)\) - teach/;
  const m1 = rx.exec(a), m2 = rx.exec(b);
  if (m1 && m2) return new Set([`${m1[1]}|${m1[2]}`, `${m1[3]}|${m1[4]}`]).size === 2 &&
    [`${m1[1]}|${m1[2]}`, `${m1[3]}|${m1[4]}`].every((x) => [`${m2[1]}|${m2[2]}`, `${m2[3]}|${m2[4]}`].includes(x));
  const words = (s: string) => s.split(/[ ,]+/).sort().join(" ");
  return a.includes("split across") && words(a) === words(b);
}

describe("v4.5.2 golden parity (expected values produced by the PowerShell engine)", () => {
  const golden = JSON.parse(rd("golden.json"));
  for (const [name, conf] of Object.entries<any>(golden.configs)) {
    it(`config ${name}: every decision matches the desktop engine`, () => {
      const k = knowledge();
      const cfg = buildClassifyConfig(conf.settings);
      const byId = new Map<string, any>(golden.candidates.map((c: any) => [c.EntryID, c]));
      expect(conf.expected.length).toBeGreaterThan(90);
      for (const exp of conf.expected) {
        const c = byId.get(exp.id);
        const d = classify({ id: c.EntryID, senderAddress: c.SenderAddress ?? "", subject: c.Subject ?? "",
          receivedAt: c.ReceivedTime, body: c.Body ?? "", attachmentNames: c.AttachmentNames ?? [] }, k, cfg);
        const got = { customerKey: d.customerKey, confidence: d.confidence, dest: d.destinationRelPath, stem: d.stem,
          source: d.matchSource, evidence: d.evidence, ruleId: d.ruleId, also: d.alsoCustomers };
        const want = { customerKey: exp.customerKey, confidence: Number(exp.confidence), dest: exp.dest, stem: exp.stem,
          source: exp.source, evidence: exp.evidence, ruleId: exp.ruleId, also: exp.also ?? [] };
        expect({ id: exp.id, ...got }).toEqual({ id: exp.id, ...want });
        expect(sameAmbiguity(d.ambiguity, exp.ambiguity), `${exp.id}: '${d.ambiguity}' vs '${exp.ambiguity}'`).toBe(true);
      }
    });
  }
});

describe("classifier behaviours named in the plan", () => {
  const k = knowledge();
  const cfg = buildClassifyConfig({ content_only_senders: "ndiconnect@ndiof.com", ignore_subject_patterns: "^Cart \\d+ was imported" });
  const base = { id: "t", subject: "PO 1", receivedAt: "2026-10-07T09:37:45", body: "", attachmentNames: [] as string[] };

  it("auto-ignores cart notices", () => {
    const d = classify({ ...base, senderAddress: "ndiconnect@ndiof.com", subject: "Cart 3029 was imported" }, k, cfg);
    expect([d.customerKey, d.matchSource, d.destinationRelPath]).toEqual(["IGNORED", "auto-ignore", "Ignored"]);
  });
  it("never routes a content-only sender by address", () => {
    const d = classify({ ...base, senderAddress: "ndiconnect@ndiof.com" }, k, cfg);
    expect(d.customerKey).toBe("UNROUTED");
    expect(d.ambiguity).toMatch(/website orders/);
  });
  it("multi-folder rule files to every listed team, first team is primary", () => {
    const d = classify({ ...base, senderAddress: "buyer@multi-sender-test.com" }, k, cfg);
    expect([d.customerKey, d.alsoCustomers]).toEqual(["TEAMTEXASLAMS", ["TEAMFLORIDAEASTC"]]);
  });
  it("internal route decides an internal sender", () => {
    const d = classify({ ...base, senderAddress: "kwilliams@ndiof.com" }, k, cfg);
    expect([d.customerKey, d.matchSource, d.confidence]).toEqual(["TEAMTEXASLAMS", "internal-sender", 0.97]);
  });
  it("stem puts the stamp last and strips illegal characters", () => {
    expect(newFileStem({ subject: 'Damaged Item/Order #1393084', receivedAt: "2026-10-07T09:37:45" }, "suffix", 120))
      .toBe("Damaged ItemOrder #1393084_20261007_093745");
  });
  it("weights a forwarded From: above a footer address", () => {
    const o = getBodyOriginators("hello\r\nFrom: A <a@x.com>\r\nfooter b@y.com");
    expect(o).toEqual([{ addr: "a@x.com", weight: 1 }, { addr: "b@y.com", weight: 0.55 }]);
  });
  it("rounds like .NET Math.Round (half to even)", () => {
    expect(roundHalfEven(0.125, 2)).toBe(0.12);
    expect(roundHalfEven(0.135, 2)).toBe(0.14);
  });
  it("content rule word/regex/scope modes", () => {
    const c = { ...base, senderAddress: "", subject: "ACME desk order", body: "cust # 71234", attachmentNames: ["Ship List.xlsx"] };
    expect(testContextRule({ phrase: "acme desk", scope: "subject", match: "word" }, c)).toBe(true);
    expect(testContextRule({ phrase: "cust(omer)?\\s*#?\\s*7\\d{4}", scope: "any", match: "regex" }, c)).toBe(true);
    expect(testContextRule({ phrase: "ship list", scope: "body", match: "contains" }, c)).toBe(false);
    expect(testContextRule({ phrase: "ship list", scope: "attachments", match: "contains" }, c)).toBe(true);
    expect(testContextRule({ phrase: "ab", scope: "any", match: "contains" }, { ...c, subject: "ab" })).toBe(false);
  });
  it("excluded senders and domains never become candidates", () => {
    const s = { excluded_domains: "arcb.com", excluded_senders: "sthomas@ndiof.com" };
    expect(isExcluded("x@mail.arcb.com", s)).toBe("excluded-domain");
    expect(isExcluded("STHOMAS@ndiof.com", s)).toBe("excluded-sender");
    expect(isExcluded("a@b.com", s)).toBeNull();
  });
});

describe("learning", () => {
  it("learns sender + domain only from confident non-context filings, never from content-only senders", () => {
    const learned = { senders: {}, domains: {} } as any;
    const opts = { ignoredDomains: [], minConf: 0.9, neverLearn: [], multiTerritory: ["azorinc.com"], contentOnly: ["ndiconnect@ndiof.com"], now: "2026-10-08T00:00:00" };
    const n = updateLearnedFromResults(learned, [
      { senderAddress: "a@dealer.com", customerKey: "E2G", confidence: 0.92, matchSource: "rule-domain", filed: true },
      { senderAddress: "b@dealer2.com", customerKey: "E2G", confidence: 0.94, matchSource: "context-rule", filed: true },
      { senderAddress: "c@dealer3.com", customerKey: "E2G", confidence: 0.85, matchSource: "learned-domain", filed: true },
      { senderAddress: "ndiconnect@ndiof.com", customerKey: "E2G", confidence: 0.99, matchSource: "taught", filed: true },
      { senderAddress: "rep@azorinc.com", customerKey: "E2G", confidence: 0.96, matchSource: "learned-sender", filed: true },
      { senderAddress: "z@gmail.com", customerKey: "E2G", confidence: 0.96, matchSource: "learned-sender", filed: true },
    ], opts);
    expect(n).toBe(3);
    expect(Object.keys(learned.senders).sort()).toEqual(["a@dealer.com", "rep@azorinc.com", "z@gmail.com"]);
    expect(Object.keys(learned.domains)).toEqual(["dealer.com"]);
  });
  it("blocks promotion of a domain whose senders file to two teams", () => {
    const learned: any = {
      senders: { "a@split.com": { customer: "E2G", count: 3, source: "auto" }, "b@split.com": { customer: "MIDWESTALPAN", count: 1, source: "auto" } },
      domains: { "split.com": { customer: "E2G", count: 5, source: "auto" }, "solo.com": { customer: "E2G", count: 3, source: "auto" } },
    };
    const mapping = parseMappingCsv(rd("customer-mapping.csv"));
    const r = promoteLearnedDomains(learned, mapping, { promoteAfter: 3, ignoredDomains: [], neverLearn: [], multiTerritory: [] });
    expect(r.promoted).toEqual([{ domain: "solo.com", customer: "E2G" }]);
    expect(r.blocked[0]).toMatch(/^split\.com -> E2G BLOCKED/);
  });
});

describe("desktop file parsers", () => {
  it("reads the ledger including host/user columns and skips the header", () => {
    const t = "# Email Archiver processed ledger - at\tkey\n2026-10-07T09:37:50\tmid:<abc@x>\tEID1\tStem_20261007\tTeam Texas & LA & MS\tPC1\triah\r\n";
    expect(parseLedger(t)).toEqual([{ at: "2026-10-07T09:37:50", key: "mid:<abc@x>", entryId: "EID1", stem: "Stem_20261007", destination: "Team Texas & LA & MS", host: "PC1", user: "riah" }]);
    expect(ledgerKey("<ABC@x>")).toBe("mid:<abc@x>");
    expect(ledgerKey("", "E1")).toBe("eid:E1");
  });
  it("reads notes and settings with a BOM", () => {
    expect(parseMailNotes('﻿{"notes":{"k":{"needsReply":"true","note":"call back"}}}')[0]).toMatchObject({ key: "k", needsReply: true, note: "call back" });
    expect(pickImportedSettings('﻿{"confidence_threshold":0.7,"dashboard_port":8788}')).toEqual({ confidence_threshold: 0.7 });
  });
});
