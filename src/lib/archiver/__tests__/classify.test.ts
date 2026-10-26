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
import { learnFromHuman } from "../filing";
import { validateContentRule, validateMultiRoute } from "../rules";
import { isFreeMailDomain, type Candidate } from "../classify";

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
      // v4.5.2 had no internal_domains / ignore_internal_replies. With them off the
      // v4.5.3 engine is v4.5.2 (the PowerShell harness proves it: v452Equivalent in
      // fixtures/v453/golden.json, 0 differences in 2 x 98 cases).
      const cfg = { ...buildClassifyConfig(conf.settings), ignoreInternalReplies: false };
      cfg.internalDomains = cfg.ignoredDomains;
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

// ------------------------------------------------------------------ v4.5.3
const FX3 = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v453");
const rd3 = (f: string) => readFileSync(join(FX3, f), "utf8");

/** Production copy of 22 Oct 2026 + test-only extras.json (applied identically by the PowerShell harness). */
function knowledge453(): Knowledge {
  const extras = JSON.parse(rd3("extras.json"));
  const learned = parseLearned(rd3("learned-routing.json"));
  for (const [k, v] of Object.entries<any>(extras.learnedDomains)) learned.domains[k] = { ...v };
  const routes: Record<string, string> = {};
  for (const r of parseInternalRoutes(rd3("internal-routes.json"))) routes[r.address] = r.customer;
  return {
    mapping: parseMappingCsv(rd3("customer-mapping.csv")),
    learned,
    ctxRules: [...parseContextRules(rd3("context-rules.json")), ...parseContextRules(JSON.stringify({ rules: extras.contextRules }))],
    internalRoutes: routes,
    multiRoutes: parseMultiRoutes(rd3("multi-routes.json")),
  };
}
/** The settings the web app holds after importing the 22 Oct config.json (internal_domains -> own_domains). */
const settings453 = () => pickImportedSettings(rd3("config.json"));
const cand = (c: any): Candidate => ({ id: c.EntryID, senderAddress: c.SenderAddress ?? "", senderName: c.SenderName ?? "",
  subject: c.Subject ?? "", receivedAt: c.ReceivedTime, body: c.Body ?? "", attachmentNames: c.AttachmentNames ?? [] });

describe("v4.5.3 golden parity (22 Oct 2026 production copy, expected values produced by the PowerShell engine)", () => {
  const golden = JSON.parse(rd3("golden.json"));
  const cands = [...JSON.parse(rd("golden.json")).candidates, ...JSON.parse(rd3("cases.json"))];
  const k = knowledge453();
  const cfg = buildClassifyConfig(settings453());
  const byId = new Map(golden.prod.map((e: any) => [e.id, e]));
  const decide = (id: string) => classify(cand(cands.find((c: any) => c.EntryID === id)), k, cfg);

  it("imported config carries every v4.5.3 key the engine reads", () => {
    const s = settings453();
    expect(s).toMatchObject({ own_domains: "ndiof.com", ignore_internal_replies: true, skip_internal_replies: true,
      never_context_domains: "quickbooks@notification.intuit.com", multi_territory_domains: "azorinc.com;bosschair.com;larnersoffice.com" });
    for (const key of ["content_only_senders", "ignore_subject_patterns", "excluded_senders", "excluded_domains"]) expect(s).toHaveProperty(key);
    expect(cfg.internalDomains).toEqual(["ndiof.com"]);
    expect(cfg.ignoreInternalReplies).toBe(true);
  });

  it(`every one of ${cands.length} decisions matches the desktop v4.5.3 engine`, () => {
    expect(golden.prod.length).toBe(cands.length);
    for (const c of cands) {
      const exp: any = byId.get(c.EntryID);
      const d = classify(cand(c), k, cfg);
      expect({ id: c.EntryID, customerKey: d.customerKey, confidence: d.confidence, dest: d.destinationRelPath, stem: d.stem,
        source: d.matchSource, evidence: d.evidence, ruleId: d.ruleId, also: d.alsoCustomers })
        .toEqual({ id: exp.id, customerKey: exp.customerKey, confidence: Number(exp.confidence), dest: exp.dest, stem: exp.stem,
          source: exp.source, evidence: exp.evidence, ruleId: exp.ruleId, also: exp.also ?? [] });
      expect(sameAmbiguity(d.ambiguity, exp.ambiguity), `${c.EntryID}: '${d.ambiguity}' vs '${exp.ambiguity}'`).toBe(true);
    }
  });

  it("a colleague's RE: is IGNORED as internal-reply (before the v4.4.3 skip check, attachments or not)", () => {
    for (const id of ["v453-tracy-re", "v453-tracy-re-attach"]) {
      const d = decide(id);
      expect([d.customerKey, d.confidence, d.destinationRelPath, d.matchSource, d.evidence])
        .toEqual(["IGNORED", 1, "Ignored", "internal-reply", "reply from tracy@ndiof.com"]);
    }
    // a system sender is not a colleague; a forward still routes
    expect(decide("v453-ndiconnect-re").matchSource).not.toBe("internal-reply");
    expect(decide("v453-colleague-fwd")).toMatchObject({ customerKey: "TEAMTEXASLAMS", matchSource: "internal-sender" });
    // switched off -> the old v4.4.3 behaviour is untouched
    const off = classify(cand(cands.find((c: any) => c.EntryID === "v453-tracy-re")), k, { ...cfg, ignoreInternalReplies: false });
    expect(off.matchSource).not.toBe("internal-reply");
  });

  it("Tracy's FW: quoting kwilliams@ndiof.com is NOT routed to Texas through kwilliams", () => {
    const d = decide("v453-tracy-fw-kwilliams");
    expect(d.customerKey).not.toBe("TEAMTEXASLAMS");
    expect(d.evidence).not.toContain("kwilliams");
    expect(d.customerKey).toBe("UNROUTED");
  });

  it("a colleague with no route and no learned sender is never routed by a learned ndiof.com domain", () => {
    expect(k.learned!.domains["ndiof.com"].customer).toBe("TEAMTEXASLAMS"); // the old bad entry, injected
    const d = decide("v453-colleague-no-route");
    expect(d.matchSource).not.toBe("learned-domain");
    expect(d.customerKey).toBe("UNROUTED");
    // the person's own learned sender still applies
    expect(decide("v453-colleague-taught-sender")).toMatchObject({ customerKey: "TEAMTEXASLAMS", matchSource: "learned-sender" });
  });

  it("QuickBooks mail with senderName 'Acme Dealer Supply' routes by a sender-scope rule", () => {
    const d = decide("v453-quickbooks-acme");
    expect([d.customerKey, d.matchSource, d.ruleId]).toEqual(["MIDWESTALPAN", "context-rule", "cr_test_acme_sender"]);
    // scope sender is the display name (trimmed, lower-cased), never the address or subject
    expect(testContextRule({ phrase: "acme dealer", scope: "sender" }, { ...cand({ EntryID: "x", ReceivedTime: "2026-10-22T11:00:00" }), senderName: "  ACME Dealer Supply " })).toBe(true);
    expect(testContextRule({ phrase: "acme dealer", scope: "sender" }, { ...cand({ EntryID: "x", ReceivedTime: "2026-10-22T11:00:00", Subject: "acme dealer" }), senderAddress: "acme dealer@x.com" })).toBe(false);
  });

  it("the 22 Oct regex rules split N & N (Florida) from Office Furniture Warehouse (Texas)", () => {
    expect(decide("v453-quickbooks-nn")).toMatchObject({ customerKey: "TEAMFLORIDAEASTC", ruleId: "cr_20261022_161500_nn01" });
    expect(decide("v453-ofw-texas")).toMatchObject({ customerKey: "TEAMTEXASLAMS", ruleId: "cr_20260908_153706_5726" });
  });

  it("teaching dlange@ndiof.com writes the sender only, no domain row", () => {
    const store: any = { senders: {}, domains: {} };
    const s = buildClassifyConfig(settings453());
    const touched = learnFromHuman(store, "DLange@ndiof.com", "TEAMTEXASLAMS", "taught", { contentOnly: s.contentOnly, ignoredDomains: s.ignoredDomains,
      internalDomains: s.internalDomains, internalPerson: "sender", multiTerritory: s.multiTerritory, freeMail: isFreeMailDomain, now: "2026-10-26T09:00:00" });
    expect(touched).toEqual([{ bucket: "sender", key: "dlange@ndiof.com" }]);
    expect(Object.keys(store.domains)).toEqual([]);
    // an outside sender still teaches its domain, as before
    const ext = learnFromHuman(store, "buyer@newdealer.com", "E2G", "taught", { contentOnly: [], ignoredDomains: [], internalDomains: s.internalDomains,
      multiTerritory: [], freeMail: isFreeMailDomain, now: "2026-10-26T09:00:00" });
    expect(ext).toEqual([{ bucket: "sender", key: "buyer@newdealer.com" }, { bucket: "domain", key: "newdealer.com" }]);
  });

  it("Wrong team? on a colleague's email moves it only - nothing is learned", () => {
    const store: any = { senders: {}, domains: {} };
    expect(learnFromHuman(store, "tracy@ndiof.com", "E2G", "corrected", { contentOnly: [], ignoredDomains: [], internalDomains: ["ndiof.com"],
      internalPerson: "none", multiTerritory: [], freeMail: isFreeMailDomain, now: "2026-10-26T09:00:00" })).toEqual([]);
    expect(store).toEqual({ senders: {}, domains: {} });
  });

  it("automatic learning never learns a colleague (same result as the PowerShell engine)", () => {
    const store: any = { senders: {}, domains: {} };
    const n = updateLearnedFromResults(store, [
      { senderAddress: "kwilliams@ndiof.com", customerKey: "TEAMTEXASLAMS", confidence: 0.97, matchSource: "internal-sender", filed: true },
      { senderAddress: "dlange@ndiof.com", customerKey: "TEAMTEXASLAMS", confidence: 0.96, matchSource: "learned-sender", filed: true },
      { senderAddress: "buyer@newdealer.com", customerKey: "E2G", confidence: 0.96, matchSource: "learned-sender", filed: true },
    ], { ignoredDomains: [], internalDomains: cfg.internalDomains, minConf: 0.9, neverLearn: [], multiTerritory: [], contentOnly: [], now: "2026-10-26T09:00:00" });
    expect({ taught: n, senders: Object.keys(store.senders).sort(), domains: Object.keys(store.domains).sort() }).toEqual(golden.learning);
  });

  it("promotion never promotes an internal domain", () => {
    const learned: any = { senders: {}, domains: { "ndiof.com": { customer: "TEAMTEXASLAMS", count: 40, source: "legacy" } } };
    const r = promoteLearnedDomains(learned, parseMappingCsv(rd3("customer-mapping.csv")),
      { promoteAfter: 3, ignoredDomains: [], internalDomains: ["ndiof.com"], neverLearn: [], multiTerritory: [] });
    expect(r.promoted).toEqual([]);
  });

  it("the 'Team,' multi-folder phrase is rejected with the desktop's wording", () => {
    const teams = new Set(["MIDWESTALPAN", "TEAMFLORIDAEASTC", "TEAMTEXASLAMS", "E2G"]);
    const three = ["MIDWESTALPAN", "TEAMFLORIDAEASTC", "TEAMTEXASLAMS"];
    for (const [key, want] of Object.entries<string[]>(golden.validation)) {
      if (!key.startsWith("multi")) continue;
      const raw = key === "multi-regex:Team," ? { kind: "phrase", value: "Team,", teams: three, match: "regex" }
        : key === "multi-sender-scope" ? { kind: "phrase", value: "Acme Dealer Supply", teams: three, scope: "sender" }
        : { kind: "phrase", value: key.slice("multi:".length), teams: three };
      const r: any = validateMultiRoute(raw, teams, ["ndiof.com"]);
      expect({ key, errors: r.ok ? [] : r.errors }).toEqual({ key, errors: want });
    }
    expect(golden.validation["multi:Team,"][0]).toMatch(/^'Team,' is too general for a multi-folder rule/);
    const ok: any = validateContentRule({ phrase: "Acme Dealer Supply", team: "MIDWESTALPAN", scope: "sender" }, teams);
    expect(ok).toMatchObject({ ok: true, value: { scope: "sender" } });
    expect((validateContentRule({ phrase: "Acme", team: "MIDWESTALPAN", scope: "header" }, teams) as any).errors).toEqual(golden.validation["content-bad-scope"]);
  });
});
