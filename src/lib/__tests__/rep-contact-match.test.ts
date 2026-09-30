import { describe, it, expect } from "vitest";
import { normName, lastTwoWords, isHouseName, matchRep, matchAllReps, type P21Contact } from "../rep-contact-match";
const c = (id: string, f: string, l: string, email: string | null, del = "N"): P21Contact => ({ id, first_name: f, last_name: l, email, delete_flag: del });

describe("rep name normalizer", () => {
  it("trims, lowercases, collapses spaces", () => {
    expect(normName("  DONNA   LANGE ")).toBe("donna lange");
  });
  it("last two words for company-prefixed reps", () => {
    expect(lastTwoWords("SOLID LINE LLC KELLY SCHAFER")).toBe("kelly schafer");
    expect(lastTwoWords("IAI GROUP PETE GEBHARDT")).toBe("pete gebhardt");
    expect(lastTwoWords("IMG SOUTH CHRIS BARNETT")).toBe("chris barnett");
    expect(lastTwoWords("Travis Speier")).toBeNull();
  });
  it("house/team/company-only names are not auto-matched", () => {
    for (const n of ["HOUSE ACCOUNT NDI", "Birmingham House Account", "Florida House Account", "Old Obsolete", "Team BNA", "ACCOUNT MULTI-REP", "Woodruff Sales Marketing", "KEN GIBSON & ASSOCIATES, LLC", "Cal Yale Assoc"])
      expect(isHouseName(n)).toBe(true);
    for (const n of ["IAI GROUP PETE GEBHARDT", "SOLID LINE LLC MARK HARTMAN", "Joe Perry"]) expect(isHouseName(n)).toBe(false);
    expect(matchRep("Team BNA", [c("1015", "Team", "BNA", "tspeier@ndiof.com")]).kind).toBe("house");
  });
});

describe("matchRep", () => {
  it("full name; skips the rep's own no-email contact and deleted ones", () => {
    const m = matchRep("Kenneth Williams", [c("3225", "Kenneth", "Williams", null, "Y"), c("5995", "KENNETH", "WILLIAMS", "kwilliams@ndiof.com"), c("4157", "Kenneth", "Williams", null)]);
    expect(m.kind === "match" && m.contact.id).toBe("5995");
  });
  it("last-two-words keeps a non-NDI address when it is the only one", () => {
    const m = matchRep("IAI GROUP PETE GEBHARDT", [c("5426", "PETE", "GEBHARDT", "pgebhardt@iai-atlanta.com")]);
    expect(m.kind === "match" && m.how).toBe("last_two_words");
  });
  it("prefers @ndiof.com among several", () => {
    const m = matchRep("RICHARD DOWNES", [c("6043", "RICHARD", "DOWNES", "RICHARD@IMGSOUTH.COM"), c("5712", "RICHARD", "DOWNES", "rdownes@ndiof.com")]);
    expect(m.kind === "match" && m.contact.id).toBe("5712");
  });
  it("several non-NDI addresses → ambiguous", () => {
    const m = matchRep("SOLID LINE LLC KELLY SCHAFER", [c("6667", "KELLY", "SCHAFER", "KSCHAFER@LYONSCOMPANYREPS.COM"), c("5327", "KELLY", "SCHAFER", "kschafer@solidlinesreps.com")]);
    expect(m.kind).toBe("ambiguous");
    expect(m.candidates).toHaveLength(2);
  });
  it("withholds a last-two-words match that is another rep's full-name address", () => {
    const contacts = [c("1016", "Joe", "Perry", "jperry@ndiof.com")];
    const r = matchAllReps([{ rep_code: "1016", rep_name: "Joe Perry" }, { rep_code: "5365", rep_name: "Melanie Joe Perry" }], contacts);
    expect(r[0]!.withheld).toBeNull();
    expect(r[1]!.withheld).toMatch(/1016/);
  });
});
