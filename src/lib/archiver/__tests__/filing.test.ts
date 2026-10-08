import { describe, expect, it, vi } from "vitest";
import {
  ledgerDestination, learnFromFiling, learnFromHuman, messageStatusFromFilings, planAction, planFilings, planRestore, storagePathFor,
  type TeamRow,
} from "../filing";
import { isFreeMailDomain } from "../classify";

vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in archiver tests"); }));

const teams = new Map<string, TeamRow>([
  ["TEAMTEXASLAMS", { key: "TEAMTEXASLAMS", folder_path: "Team Texas & LA & MS", kind: "team" }],
  ["E2G", { key: "E2G", folder_path: "#E2G", kind: "team" }],
  ["MIDWESTALPAN", { key: "MIDWESTALPAN", folder_path: "Mid West & AL Pan", kind: "team" }],
  ["IGNORED", { key: "IGNORED", folder_path: "Ignored", kind: "ignored" }],
  ["UNROUTED", { key: "UNROUTED", folder_path: "Unrouted", kind: "unrouted" }],
]);

describe("planning file writes", () => {
  it("files the primary team and one copy per extra team, with stable idempotency keys", () => {
    const p = planFilings("m1", { customerKey: "TEAMTEXASLAMS", alsoCustomers: ["E2G", "TEAMTEXASLAMS"], stem: "PO 1_20261008_090600" }, teams);
    expect(p).toEqual([
      { team_key: "TEAMTEXASLAMS", kind: "primary", rel_path: "Team Texas & LA & MS", file_name: "PO 1_20261008_090600.eml", idempotency_key: "file:m1:TEAMTEXASLAMS:primary" },
      { team_key: "E2G", kind: "copy", rel_path: "#E2G", file_name: "PO 1_20261008_090600.eml", idempotency_key: "file:m1:E2G:copy" },
    ]);
    expect(planFilings("m1", { customerKey: "SKIPPED", alsoCustomers: [], stem: "x" }, teams)).toEqual([]);
    expect(planFilings("m2", { customerKey: "UNROUTED", alsoCustomers: [], stem: "x" }, teams)[0].rel_path).toBe("Unrouted");
    expect(() => planFilings("m3", { customerKey: "NOPE", alsoCustomers: [], stem: "x" }, teams)).toThrow(/no folder/);
  });
  it("stores MIME under year/month/message id", () => {
    expect(storagePathFor("abc", "2026-10-08T14:06:00Z")).toBe("2026/10/abc.eml");
  });
});

describe("human actions", () => {
  const files = [
    { filing_id: "f1", team_key: "TEAMTEXASLAMS", kind: "primary", written_path: "Team Texas & LA & MS/PO 1.eml", status: "done" },
    { filing_id: "f2", team_key: "E2G", kind: "copy", written_path: "#E2G/PO 1.eml", status: "done" },
  ];
  it("Wrong team? moves the primary file and supersedes it", () => {
    expect(planAction("m1", { action: "wrong_team", toTeam: "MIDWESTALPAN" }, files, teams, "t1")).toEqual([
      { fromRelPath: "Team Texas & LA & MS/PO 1.eml", toRelDir: "Mid West & AL Pan", mode: "move", team_key: "MIDWESTALPAN", kind: "refile",
        idempotency_key: "move:m1:MIDWESTALPAN:refile:t1", supersedes: "f1" },
    ]);
    expect(planAction("m1", { action: "wrong_team", toTeam: "TEAMTEXASLAMS" }, files, teams, "t1")).toEqual([]);
    expect(() => planAction("m1", { action: "wrong_team", toTeam: "E2G" }, [], teams, "t1")).toThrow(/no filed copy/);
  });
  it("Archive moves every copy to Ignored; Restore brings the primary back", () => {
    const a = planAction("m1", { action: "archive" }, files, teams, "t2");
    expect(a.map((x) => [x.fromRelPath, x.toRelDir, x.kind])).toEqual([
      ["Team Texas & LA & MS/PO 1.eml", "Ignored", "archive"], ["#E2G/PO 1.eml", "Ignored", "archive"]]);
    const archived = [{ filing_id: "f3", team_key: "IGNORED", kind: "archive", written_path: "Ignored/PO 1.eml", status: "done" }];
    expect(planRestore("m1", archived, "TEAMTEXASLAMS", teams, "t3")[0]).toMatchObject({ fromRelPath: "Ignored/PO 1.eml", toRelDir: "Team Texas & LA & MS", kind: "restore", supersedes: "f3" });
    expect(() => planRestore("m1", files, "TEAMTEXASLAMS", teams, "t3")).toThrow(/not archived/);
  });
  it("Also file to copies only to teams that do not have it yet", () => {
    const c = planAction("m1", { action: "also_file", teams: ["E2G", "MIDWESTALPAN"] }, files, teams, "t4");
    expect(c.map((x) => [x.toRelDir, x.mode, x.kind])).toEqual([["Mid West & AL Pan", "copy", "copy"]]);
  });
});

describe("status and ledger", () => {
  it("derives the email's status from its filings", () => {
    expect(messageStatusFromFilings([{ kind: "primary", status: "queued" }])).toBe("queued");
    expect(messageStatusFromFilings([{ kind: "primary", status: "done" }, { kind: "copy", status: "error" }])).toBe("failed");
    expect(messageStatusFromFilings([{ kind: "primary", status: "superseded" }, { kind: "archive", status: "done" }])).toBe("archived");
    expect(messageStatusFromFilings([{ kind: "primary", status: "superseded" }, { kind: "refile", status: "done" }])).toBe("filed");
  });
  it("writes ledger destinations in the desktop format", () => {
    expect(ledgerDestination("Team Texas & LA & MS", ["#E2G"])).toBe("Team Texas & LA & MS (+ copies: #E2G)");
    expect(ledgerDestination("Ignored", [])).toBe("Ignored");
  });
});

describe("learning", () => {
  const opts = { ignoredDomains: [], neverLearn: [], multiTerritory: ["azorinc.com"], contentOnly: ["ndiconnect@ndiof.com"], now: "2026-10-08T09:00:00", runId: "r" };
  it("learns from a confident filing, not from context or content-only senders", () => {
    const s: any = { senders: {}, domains: {} };
    expect(learnFromFiling(s, { senderAddress: "a@dealer.com", customerKey: "E2G", confidence: 0.92, matchSource: "rule-domain" }, opts).changed).toBe(true);
    expect(learnFromFiling(s, { senderAddress: "b@d2.com", customerKey: "E2G", confidence: 0.94, matchSource: "context-rule" }, opts).changed).toBe(false);
    expect(learnFromFiling(s, { senderAddress: "ndiconnect@ndiof.com", customerKey: "E2G", confidence: 0.99, matchSource: "rule-domain" }, opts).changed).toBe(false);
    expect(Object.keys(s.senders)).toEqual(["a@dealer.com"]);
  });
  it("Wrong team? corrects sender and domain; content-only senders only move", () => {
    const s: any = { senders: { "a@dealer.com": { customer: "E2G", count: 4, source: "auto" } }, domains: {} };
    const t = learnFromHuman(s, "A@Dealer.com", "MIDWESTALPAN", "corrected", { ...opts, freeMail: isFreeMailDomain });
    expect(t).toEqual([{ bucket: "sender", key: "a@dealer.com" }, { bucket: "domain", key: "dealer.com" }]);
    expect(s.senders["a@dealer.com"]).toMatchObject({ customer: "MIDWESTALPAN", count: 4, source: "corrected" });
    expect(learnFromHuman(s, "ndiconnect@ndiof.com", "E2G", "corrected", { ...opts, freeMail: isFreeMailDomain })).toEqual([]);
    expect(learnFromHuman(s, "joe@gmail.com", "E2G", "taught", { ...opts, freeMail: isFreeMailDomain })).toEqual([{ bucket: "sender", key: "joe@gmail.com" }]);
    expect(learnFromHuman(s, "rep@azorinc.com", "E2G", "taught", { ...opts, freeMail: isFreeMailDomain })).toEqual([{ bucket: "sender", key: "rep@azorinc.com" }]);
  });
});
