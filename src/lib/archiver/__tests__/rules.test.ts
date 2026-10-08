import { describe, expect, it, vi } from "vitest";
import { chicagoDayBounds, isOwnAddress, previewPhrase, validateContentRule, validateInternalRoute, validateMultiRoute } from "../rules";

vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in archiver tests"); }));
const TEAMS = new Set(["TEAMTEXASLAMS", "E2G", "MIDWESTALPAN", "TEAMFLORIDAEASTC"]);

describe("content rules", () => {
  it("accepts a normal phrase with defaults", () => {
    expect(validateContentRule({ phrase: " Worthington ", team: "TEAMTEXASLAMS" }, TEAMS)).toEqual({ ok: true,
      value: { phrase: "Worthington", team_key: "TEAMTEXASLAMS", scope: "any", match: "contains", weight: 0.94, note: "" } });
  });
  it("refuses the same things the desktop refuses", () => {
    const bad = (r: any) => (validateContentRule(r, TEAMS) as any).errors.join(" | ");
    expect(bad({ phrase: "ab", team: "E2G" })).toMatch(/at least 3/);
    expect(bad({ phrase: "x".repeat(201), team: "E2G" })).toMatch(/too long/);
    expect(bad({ phrase: "abc", team: "NOPE" })).toMatch(/Unknown customer/);
    expect(bad({ phrase: "abc", team: "E2G", scope: "header" })).toMatch(/Scope/);
    expect(bad({ phrase: "abc", team: "E2G", weight: 0.3 })).toMatch(/Weight/);
    expect(bad({ phrase: "(unclosed", team: "E2G", match: "regex" })).toMatch(/Regex/);
    expect(bad({ phrase: "jeff@larnersoffice.com", team: "E2G" })).toMatch(/teach it as a sender/);
  });
});

describe("multi-folder rules", () => {
  const own = ["ndiof.com"];
  it("needs two known teams and a valid value per kind", () => {
    expect(validateMultiRoute({ kind: "sender", value: "Buyer@Dealer.com", teams: ["E2G", "MIDWESTALPAN"] }, TEAMS, own))
      .toMatchObject({ ok: true, value: { kind: "sender", value: "buyer@dealer.com", scope: "", match: "" } });
    expect(validateMultiRoute({ kind: "domain", value: "@dealer.com", teams: ["E2G", "MIDWESTALPAN"] }, TEAMS, own)).toMatchObject({ ok: true, value: { value: "dealer.com" } });
    const errs = (r: any) => (validateMultiRoute(r, TEAMS, own) as any).errors.join(" | ");
    expect(errs({ kind: "domain", value: "ndiof.com", teams: ["E2G", "MIDWESTALPAN"] })).toMatch(/your own domain/);
    expect(errs({ kind: "sender", value: "x", teams: ["E2G"] })).toMatch(/not an email address.*at least two teams/);
    expect(errs({ kind: "phrase", value: "rush", teams: ["E2G", "BAD"] })).toMatch(/Unknown team 'BAD'/);
  });
});

describe("internal routes", () => {
  const settings = { content_only_senders: "ndiconnect@ndiof.com", ignored_domains: "" };
  it("allows our own people even though ignored_domains is blank", () => {
    expect(validateInternalRoute({ address: "TChase@ndiof.com", team: "TEAMTEXASLAMS" }, TEAMS, settings))
      .toEqual({ ok: true, value: { address: "tchase@ndiof.com", team_key: "TEAMTEXASLAMS", note: "" } });
    expect(isOwnAddress("x@ndiof.onmicrosoft.com", ["ndiof.com"])).toBe(true);
  });
  it("refuses outside senders and the website-order sender", () => {
    expect((validateInternalRoute({ address: "jeff@larnersoffice.com", team: "E2G" }, TEAMS, settings) as any).errors[0]).toMatch(/not one of your own domains/);
    expect((validateInternalRoute({ address: "ndiconnect@ndiof.com", team: "E2G" }, TEAMS, settings) as any).errors[0]).toMatch(/system sender/);
  });
});

describe("helpers", () => {
  it("previews a phrase over recent mail", () => {
    const r = previewPhrase({ phrase: "worthington" }, [
      { subject: "PO from Worthington", body: "", attachmentNames: [], team_key: "TEAMTEXASLAMS" },
      { subject: "x", body: "worthington direct", attachmentNames: [], team_key: null },
      { subject: "y", body: "", attachmentNames: [], team_key: "E2G" },
    ]);
    expect(r).toEqual({ matched: 2, byTeam: { TEAMTEXASLAMS: 1, UNROUTED: 1 } });
  });
  it("computes Chicago day bounds across DST", () => {
    expect(chicagoDayBounds(new Date("2026-10-08T15:00:00Z"))).toEqual({ start: "2026-10-08T05:00:00.000Z", end: "2026-10-09T05:00:00.000Z" });
    expect(chicagoDayBounds(new Date("2026-01-15T03:00:00Z"))).toEqual({ start: "2026-01-14T06:00:00.000Z", end: "2026-01-15T06:00:00.000Z" });
  });
});
