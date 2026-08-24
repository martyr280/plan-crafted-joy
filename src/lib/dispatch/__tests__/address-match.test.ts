import { describe, expect, it } from "vitest";
import {
  FUZZY_THRESHOLD,
  isGeocodable,
  normalizeAddress,
  normalizeCity,
  normalizeState,
  rankCandidates,
  resolveAddress,
  scoreAddresses,
  stripUnit,
  expandStreetWords,
  zip5,
} from "../address-match";

describe("address normalization", () => {
  it("normalizes golden pairs to the same string", () => {
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
        { addr1: "900 Commerce Blvd, Suite 200", city: "Austin", state: "TX", zip: "78701" },
        { addr1: "900 Commerce Boulevard", addr2: "Ste 200", city: "Austin", state: "TX", zip: "78701" },
      ],
    ];
    for (const [a, b] of pairs) {
      const na = normalizeAddress(a);
      const nb = normalizeAddress(b);
      expect(`${na.street}|${na.city}|${na.state}|${na.zip}`).toBe(`${nb.street}|${nb.city}|${nb.state}|${nb.zip}`);
    }
  });

  it("strips unit designators and expands street words", () => {
    expect(stripUnit("900 Commerce Blvd Suite 200")).not.toMatch(/suite/i);
    expect(stripUnit("12 Elm St Unit B")).not.toMatch(/unit/i);
    expect(expandStreetWords("MAIN ST")).toMatch(/STREET/);
    expect(expandStreetWords("OAK AVE")).toMatch(/AVENUE/);
  });

  it("reduces zip to five digits and uppercases city/state", () => {
    expect(zip5("75201-1234")).toBe("75201");
    expect(zip5(" 75201 ")).toBe("75201");
    expect(zip5(null)).toBe("");
    expect(normalizeCity(" dallas ")).toBe("DALLAS");
    expect(normalizeState("tx")).toBe("TX");
  });
});

describe("similarity scoring", () => {
  it("scores identical addresses at 1", () => {
    const a = { addr1: "123 Main St", city: "Dallas", state: "TX", zip: "75201" };
    expect(scoreAddresses(a, a).score).toBe(1);
  });

  it("scores a different street in the same city well below the threshold", () => {
    const a = { addr1: "123 Main St", city: "Dallas", state: "TX", zip: "75201" };
    const b = { addr1: "9871 Industrial Parkway", city: "Dallas", state: "TX", zip: "75201" };
    expect(scoreAddresses(a, b).score).toBeLessThan(FUZZY_THRESHOLD);
  });

  it("ranks candidates descending", () => {
    const target = { addr1: "123 Main St", city: "Dallas", state: "TX", zip: "75201" };
    const ranked = rankCandidates(target, [
      { id: "far", raw: { addr1: "77 Elm Rd", city: "Waco", state: "TX", zip: "76701" } },
      { id: "near", raw: { addr1: "123 Main Street", city: "Dallas", state: "TX", zip: "75201-9000" } },
    ]);
    expect(ranked[0]!.id).toBe("near");
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });
});

describe("resolution ladder", () => {
  const raw = { addr1: "123 Main St", city: "Dallas", state: "TX", zip: "75201" };

  it("verified map hit -> mapped", () => {
    const d = resolveAddress({
      raw,
      mapped: { p21_ship_to_id: "1", samsara_address_id: "addr_1", verified: true },
      candidates: [],
    });
    expect(d.action).toBe("mapped");
  });

  it("unverified map hit does not short-circuit to mapped", () => {
    const d = resolveAddress({
      raw,
      mapped: { p21_ship_to_id: "1", samsara_address_id: "addr_1", verified: false },
      candidates: [],
    });
    expect(d.action).not.toBe("mapped");
  });

  it("fuzzy candidate at or above 0.85 -> propose, just below -> not propose", () => {
    const at = resolveAddress({
      raw,
      mapped: null,
      candidates: [{ id: "addr_2", raw: { addr1: "123 Main Street", city: "Dallas", state: "TX", zip: "75201" } }],
    });
    expect(at.action).toBe("propose");

    const below = resolveAddress({
      raw,
      mapped: null,
      candidates: [{ id: "addr_3", raw: { addr1: "9871 Industrial Parkway", city: "Waco", state: "TX", zip: "76701" } }],
    });
    expect(below.action).not.toBe("propose");
  });

  it("geocodable but unmatched -> create; unusable -> hold", () => {
    const create = resolveAddress({ raw, mapped: null, candidates: [] });
    expect(create.action).toBe("create");

    const hold = resolveAddress({
      raw: { addr1: "", city: "", state: "", zip: "" },
      mapped: null,
      candidates: [],
    });
    expect(hold.action).toBe("hold");
  });

  it("isGeocodable requires street plus city/state or zip", () => {
    expect(isGeocodable(raw)).toBe(true);
    expect(isGeocodable({ addr1: "", city: "Dallas", state: "TX", zip: "75201" })).toBe(false);
    expect(isGeocodable({ addr1: "123 Main St", city: "", state: "", zip: "" })).toBe(false);
  });
});
