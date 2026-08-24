// Pure address normalization + matching for Samsara Route Dispatch.
//
// P21 ship-to addresses are hand-typed and inconsistent ("123 N Main St Ste 4"
// vs "123 NORTH MAIN STREET, SUITE #4"). Samsara routes need a stable
// addressId, so every P21 ship_to_id must resolve to exactly one Samsara
// address. This module owns the normalization and the scoring; the resolution
// ladder decision is a pure function so the server layer never invents policy.
//
// No I/O. Everything here is unit-tested.

export type RawAddress = {
  addr1?: string | null;
  addr2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export type NormalizedAddress = {
  street: string;
  city: string;
  state: string;
  zip: string;
  /** Everything joined — used for exact comparison. */
  key: string;
};

export type MatchResult = {
  /** 0..1 */
  score: number;
  method: "exact" | "fuzzy";
};

/** Fuzzy candidates at or above this score may be proposed for review. */
export const FUZZY_THRESHOLD = 0.85;

/* ----------------------------------------------------------- normalization */

const STREET_WORDS: Record<string, string> = {
  ST: "STREET",
  STR: "STREET",
  AVE: "AVENUE",
  AV: "AVENUE",
  RD: "ROAD",
  DR: "DRIVE",
  BLVD: "BOULEVARD",
  LN: "LANE",
  CT: "COURT",
  PKWY: "PARKWAY",
  PKY: "PARKWAY",
  HWY: "HIGHWAY",
  CIR: "CIRCLE",
  PL: "PLACE",
  TER: "TERRACE",
  TRL: "TRAIL",
  SQ: "SQUARE",
  N: "NORTH",
  S: "SOUTH",
  E: "EAST",
  W: "WEST",
  NE: "NORTHEAST",
  NW: "NORTHWEST",
  SE: "SOUTHEAST",
  SW: "SOUTHWEST",
};

/** Secondary-unit designators that carry no routing signal for a truck stop. */
const UNIT_WORDS = new Set([
  "SUITE",
  "STE",
  "UNIT",
  "APT",
  "APARTMENT",
  "BLDG",
  "BUILDING",
  "FL",
  "FLOOR",
  "RM",
  "ROOM",
  "DEPT",
  "DEPARTMENT",
  "SPACE",
  "SPC",
  "LOT",
  "TRLR",
  "DOOR",
]);

function upperClean(v: string | null | undefined): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[.,#;:'"()\/\\]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip a trailing (or embedded) suite/unit designator and its identifier.
 * "123 MAIN ST STE 4" -> "123 MAIN ST"; "123 MAIN ST 2ND FLOOR" -> "123 MAIN ST".
 */
export function stripUnit(text: string): string {
  const tokens = upperClean(text).split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (UNIT_WORDS.has(t)) {
      // Drop the designator plus a single following identifier token, if any.
      if (i + 1 < tokens.length && /^[0-9A-Z]{1,6}$/.test(tokens[i + 1]!)) i++;
      continue;
    }
    // Ordinal floor forms: 2ND, 3RD immediately before FLOOR were handled above
    // when FLOOR came first; handle the reverse order too.
    if (/^\d+(ST|ND|RD|TH)$/.test(t) && UNIT_WORDS.has(tokens[i + 1] ?? "")) {
      i++;
      continue;
    }
    out.push(t);
  }
  return out.join(" ");
}

export function expandStreetWords(text: string): string {
  return upperClean(text)
    .split(" ")
    .filter(Boolean)
    .map((t) => STREET_WORDS[t] ?? t)
    .join(" ");
}

export function normalizeStreet(addr1: string | null | undefined, addr2?: string | null): string {
  const a1 = expandStreetWords(stripUnit(addr1 ?? ""));
  // addr2 is only kept when it is NOT a unit line and adds street signal.
  const a2raw = stripUnit(addr2 ?? "");
  const a2 = a2raw && /\d/.test(a2raw) && !/^\d{1,6}$/.test(a2raw) ? expandStreetWords(a2raw) : "";
  return [a1, a2].filter(Boolean).join(" ").trim();
}

/**
 * Cities get their OWN normalizer. Running street-word expansion over a city
 * name is a latent data-corruption trap: MOAR1 serves St. Louis suburbs, and
 * expandStreetWords would turn "St Louis" into "STREET LOUIS" while a P21 row
 * spelled "Saint Louis" normalized to "SAINT LOUIS" — two keys for one city,
 * so the template lookup silently misses and the stop lands unslotted.
 *
 * So: no street-word expansion here. The one expansion a city name needs is a
 * leading "St"/"St." -> "SAINT".
 */
export function normalizeCity(city: string | null | undefined): string {
  const tokens = upperClean(city).split(" ").filter(Boolean);
  if (tokens.length > 1 && (tokens[0] === "ST" || tokens[0] === "SAINT")) tokens[0] = "SAINT";
  return tokens.join(" ");
}


export function normalizeState(state: string | null | undefined): string {
  return upperClean(state).replace(/\s+/g, "").slice(0, 2);
}

export function zip5(zip: string | null | undefined): string {
  const digits = String(zip ?? "").replace(/\D/g, "");
  return digits.slice(0, 5);
}

export function normalizeAddress(raw: RawAddress): NormalizedAddress {
  const street = normalizeStreet(raw.addr1, raw.addr2);
  const city = normalizeCity(raw.city);
  const state = normalizeState(raw.state);
  const zip = zip5(raw.zip);
  return { street, city, state, zip, key: [street, city, state, zip].join("|") };
}

/* --------------------------------------------------------------- similarity */

function tokens(text: string): string[] {
  return text.split(" ").filter(Boolean);
}

/** Sørensen–Dice coefficient over token multisets. */
export function tokenDice(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  const pool = [...tb];
  let hits = 0;
  for (const t of ta) {
    const i = pool.indexOf(t);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return (2 * hits) / (ta.length + tb.length);
}

/**
 * Score two addresses. Street carries most of the weight; city/state/zip are
 * confirmations. Identical normalized keys short-circuit to an exact match.
 */
export function scoreAddresses(a: RawAddress | NormalizedAddress, b: RawAddress | NormalizedAddress): MatchResult {
  const na = "key" in a ? a : normalizeAddress(a);
  const nb = "key" in b ? b : normalizeAddress(b);
  if (na.key === nb.key && na.street !== "") return { score: 1, method: "exact" };

  const street = tokenDice(na.street, nb.street);
  const city = na.city && nb.city ? (na.city === nb.city ? 1 : tokenDice(na.city, nb.city)) : 0;
  const state = na.state && nb.state ? (na.state === nb.state ? 1 : 0) : 0;
  const zip = na.zip && nb.zip ? (na.zip === nb.zip ? 1 : 0) : 0;

  const score = 0.6 * street + 0.2 * city + 0.1 * state + 0.1 * zip;
  return { score: Math.max(0, Math.min(1, score)), method: "fuzzy" };
}

export type AddressCandidate = {
  samsaraAddressId: string;
  address: RawAddress;
};

export type ScoredCandidate = AddressCandidate & MatchResult;

/** Score every candidate and return them best-first. */
export function rankCandidates(target: RawAddress, candidates: AddressCandidate[]): ScoredCandidate[] {
  return candidates
    .map((c) => ({ ...c, ...scoreAddresses(target, c.address) }))
    .sort((x, y) => y.score - x.score || x.samsaraAddressId.localeCompare(y.samsaraAddressId));
}

/* ---------------------------------------------------------- decision ladder */

export type ResolutionDecision =
  | { decision: "mapped"; samsaraAddressId: string }
  | { decision: "propose"; samsaraAddressId: string; score: number; method: "exact" | "fuzzy" }
  | { decision: "create" }
  | { decision: "hold"; reason: "unmapped_address" };

export type ResolutionInput = {
  /** A verified row from samsara_address_map, if one exists. */
  mapped?: { samsara_address_id: string | null; verified: boolean } | null;
  /** Best fuzzy candidate from existing Samsara addresses, if any. */
  bestCandidate?: { samsaraAddressId: string; score: number; method: "exact" | "fuzzy" } | null;
  /** True when the raw address has enough signal to geocode / create in Samsara. */
  geocodable?: boolean;
};

/**
 * verified map hit -> mapped
 * fuzzy candidate >= 0.85 -> propose
 * geocodable -> create
 * otherwise -> hold
 */
export function resolveAddress(input: ResolutionInput): ResolutionDecision {
  const m = input.mapped;
  if (m?.verified && m.samsara_address_id) {
    return { decision: "mapped", samsaraAddressId: m.samsara_address_id };
  }
  const c = input.bestCandidate;
  if (c && c.samsaraAddressId && c.score >= FUZZY_THRESHOLD) {
    return { decision: "propose", samsaraAddressId: c.samsaraAddressId, score: c.score, method: c.method };
  }
  if (input.geocodable) return { decision: "create" };
  return { decision: "hold", reason: "unmapped_address" };
}

/** Minimum signal Samsara needs to place an address: street + (city+state or zip). */
export function isGeocodable(raw: RawAddress): boolean {
  const n = normalizeAddress(raw);
  if (!n.street || !/\d/.test(n.street)) return false;
  return Boolean((n.city && n.state) || n.zip.length === 5);
}
