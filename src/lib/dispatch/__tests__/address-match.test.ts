import { describe, expect, it } from "vitest";
import {
  FUZZY_THRESHOLD,
  expandStreetWords,
  isGeocodable,
  normalizeAddress,
  normalizeCity,
  normalizeState,
  rankCandidates,
  resolveAddress,
  scoreAddresses,
  stripUnit,
  zip5,
} from "../address-match";

describe("address normalization", () => {
  it("normalizes golden pairs to the same key", () => {
    const pairs: Array<[Parameters<typeof normalizeAddress>[0], Parameters<typeof normalizeAddress>[0]]> = [
      [
        { addr1: "123 Main St.", city: "Dallas", state: "tx", zip: "75201-1234" },
        { addr1: "123 MAIN STREET", city: "dallas", state: "TX", zip: "75201" },
      ],
      [
        { addr1: "45 N. Oak Ave", city: "Fort Worth", state: "TX", zip: "76102" },
        { addr1: "45 N Oak Avenue", city: "FORT WORTH", state: "tx", zip: "76102" },
      ],
      [
        { addr1: "900 Commerce Blvd Suite 200", city: "Austin", state: "TX", zip: "78701" },
        { addr1: "900 Commerce Boulevard", addr2: "Ste 200", city: "Austin", state: "TX", zip: "78701" },
      ],
    ];
    for (const [a, b] of pairs) {
      expect(normalizeAddress(a).key).toBe(normalizeAddress(b).key);
    }
  });

  it("strips unit designators and expands street words", () => {
    expect(stripUnit("900 Commerce Blvd Suite 200")).not.toMatch(/SUITE/);
    expect(stripUnit("12 Elm St Unit B")).not.toMatch(/UNIT/);
    expect(expandStreetWords("MAIN ST")).toMatch(/STREET/);
    expect(expandStreetWords("OAK AVE")).toMatch(/AVENUE/);
  });

  it("reduces zip to five digits and uppercases city/state", () => {
    expect(zip5("75201-1234")).toBe("75201");
    expect(zip5(" 75201 ")).toBe("75201");
    expect(zip5(null)).toBe("");
    expect(normalizeCity(" dallas ")).toBe("DALLAS");
    expect(normalizeState("tx")).toBe("TX");
    expect(normalizeState("Texas")).toBe("TE"); // two-char truncation is intentional
  });
});

describe("similarity scoring", () => {
  const target = { addr1: "123 Main St", city: "Dallas", state: "TX", zip: "75201" };

  it("scores identical addresses at 1 and calls it exact", () => {
    const r = scoreAddresses(target, { addr1: "123 MAIN STREET", city: "DALLAS", state: "TX", zip: "75201" });
    expect(r.score).toBe(1);
    expect(r.method).toBe("exact");
  });

  it("scores a different street in the same city below the 0.85 threshold", () => {
    const r = scoreAddresses(target, { addr1: "9871 Industrial Parkway", city: "Dallas", state: "TX", zip: "75201" });
    expect(r.score).toBeLessThan(FUZZY_THRESHOLD);
  });

  it("ranks candidates best-first", () => {
    const ranked = rankCandidates(target, [
      { samsaraAddressId: "far", address: { addr1: "77 Elm Rd", city: "Waco", state: "TX", zip: "76701" } },
      { samsaraAddressId: "near", address: { addr1: "123 Main Street", city: "Dallas", state: "TX", zip: "75201" } },
    ]);
    expect(ranked[0]!.samsaraAddressId).toBe("near");
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });
});

describe("resolution ladder", () => {
  it("verified map hit -> mapped", () => {
    const d = resolveAddress({ mapped: { samsara_address_id: "addr_1", verified: true }, geocodable: true });
    expect(d).toEqual({ decision: "mapped", samsaraAddressId: "addr_1" });
  });

  it("unverified map hit does not short-circuit to mapped", () => {
    const d = resolveAddress({ mapped: { samsara_address_id: "addr_1", verified: false }, geocodable: true });
    expect(d.decision).toBe("create");
  });

  it("fuzzy candidate exactly at 0.85 -> propose", () => {
    const d = resolveAddress({
      bestCandidate: { samsaraAddressId: "addr_2", score: FUZZY_THRESHOLD, method: "fuzzy" },
      geocodable: true,
    });
    expect(d.decision).toBe("propose");
  });

  it("fuzzy candidate just below 0.85 -> create, not propose", () => {
    const d = resolveAddress({
      bestCandidate: { samsaraAddressId: "addr_2", score: FUZZY_THRESHOLD - 0.0001, method: "fuzzy" },
      geocodable: true,
    });
    expect(d.decision).toBe("create");
  });

  it("not geocodable and no candidate -> hold", () => {
    expect(resolveAddress({ geocodable: false })).toEqual({ decision: "hold", reason: "unmapped_address" });
  });

  it("isGeocodable requires a numbered street plus city/state or zip", () => {
    expect(isGeocodable({ addr1: "123 Main St", city: "Dallas", state: "TX", zip: "75201" })).toBe(true);
    expect(isGeocodable({ addr1: "Main St", city: "Dallas", state: "TX", zip: "75201" })).toBe(false);
    expect(isGeocodable({ addr1: "", city: "Dallas", state: "TX", zip: "75201" })).toBe(false);
    expect(isGeocodable({ addr1: "123 Main St", city: "", state: "", zip: "" })).toBe(false);
  });
});
