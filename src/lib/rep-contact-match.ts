// Pure: match a P21 sales rep to a P21 contact by NAME. P21 salesrep IDs and
// contact IDs are different key spaces, so an ID join is wrong (1015 Team BNA
// collided with Travis Speier's contact id).

export type P21Contact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  delete_flag: string | null;
};

export type RepMatch =
  | { kind: "match"; contact: P21Contact; how: "full_name" | "last_two_words"; candidates: P21Contact[] }
  | { kind: "none" | "ambiguous" | "house"; how: "full_name" | "last_two_words" | null; candidates: P21Contact[] };

export const normName = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** Last two words of a rep name ("SOLID LINE LLC KELLY SCHAFER" → "kelly schafer"). */
export function lastTwoWords(s: string | null | undefined): string | null {
  const w = normName(s).split(" ").filter(Boolean);
  return w.length > 2 ? w.slice(-2).join(" ") : null;
}

const HOUSE = /\b(house|account|obsolete|team|assoc|associates|marketing|multi-rep)\b|&/i;
/** House/team/company-only names: never auto-matched. */
export const isHouseName = (s: string | null | undefined) => HOUSE.test(s ?? "");

const contactName = (c: P21Contact) => normName(`${c.first_name ?? ""} ${c.last_name ?? ""}`);
const isActive = (c: P21Contact) => (c.delete_flag ?? "N").toUpperCase() !== "Y";
const hasEmail = (c: P21Contact) => !!(c.email ?? "").trim();

/** Among name hits: active + email; then prefer @ndiof.com if several; exactly one → match. */
function pick(hits: P21Contact[]): P21Contact | null {
  const usable = hits.filter((c) => isActive(c) && hasEmail(c));
  if (usable.length === 1) return usable[0]!;
  if (usable.length > 1) {
    const emails = new Set(usable.map((c) => c.email!.trim().toLowerCase()));
    if (emails.size === 1) return usable[0]!; // duplicates of the same person/address
    const ndi = usable.filter((c) => /@ndiof\.com$/i.test(c.email!.trim()));
    const ndiEmails = new Set(ndi.map((c) => c.email!.trim().toLowerCase()));
    if (ndiEmails.size === 1) return ndi[0]!;
  }
  return null;
}

export function matchRep(repName: string | null, contacts: P21Contact[]): RepMatch {
  const full = normName(repName);
  const byName = (n: string) => contacts.filter((c) => contactName(c) === n);
  if (!full) return { kind: "none", how: null, candidates: [] };
  if (isHouseName(repName)) {
    const hits = [...byName(full), ...(lastTwoWords(repName) ? byName(lastTwoWords(repName)!) : [])];
    return { kind: "house", how: null, candidates: hits };
  }
  const tries: Array<["full_name" | "last_two_words", string]> = [["full_name", full]];
  const l2 = lastTwoWords(repName);
  if (l2) tries.push(["last_two_words", l2]);
  let lastHits: P21Contact[] = [];
  let lastHow: "full_name" | "last_two_words" | null = null;
  for (const [how, n] of tries) {
    const hits = byName(n);
    if (!hits.length) continue;
    const c = pick(hits);
    if (c) return { kind: "match", contact: c, how, candidates: hits };
    lastHits = hits;
    lastHow = how;
  }
  return { kind: lastHits.length ? "ambiguous" : "none", how: lastHow, candidates: lastHits };
}

export const REP_EMAIL_NOTE = (contactId: string) => `P21 contact by name match (${contactId}), unconfirmed`;
