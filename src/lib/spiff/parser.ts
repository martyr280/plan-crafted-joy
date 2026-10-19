// Writing-rep parsing from PO NUMBER free-text.
// Examples seen in the real workbook:
//   "DONNIE REILLY / 6470"
//   "Donnie Reilly 1374105/ 6326"
//   "Chris Godhsall 69049A-V1"
//   "Steven Finckel 15863"
//
// Rule: take the leading alphabetic name portion (stop at first digit OR '/').
// Trim, collapse whitespace, title-case. If nothing parses, return null.

export type ParsedRep = {
  rep: string | null;
  confidence: "parsed" | "unmatched";
};

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function parseWritingRep(poNo: string | null | undefined): ParsedRep {
  const raw = String(poNo ?? "").trim();
  if (!raw) return { rep: null, confidence: "unmatched" };

  // Take everything before the first digit or '/'.
  const m = raw.match(/^([A-Za-z][A-Za-z .'`-]*?)(?=\s*[\d/])/);
  let name = m ? m[1] : "";
  // A PO number like "A38551-1" / "EEW12614" / "CR726NDI" glued to the name: a trailing
  // 1–3 letter token IMMEDIATELY followed by a digit is part of the PO, not the name.
  // Drop it only if at least two words remain; longer tokens may be real surnames.
  // Letters glued onto a surname with no space ("WAGNERL4471") are intentionally NOT
  // split — indistinguishable from a real name here; handle those as a data alias.
  // KNOWN LIMITATION: a real surname of <=3 letters glued to digits in a 3+ word
  // name is dropped ("MARY ANN LEE4471" -> "Mary Ann"). No live Q1–Q3 PO hits
  // this (Design scan of 834 strings); pinned by a test, handle via data alias.
  if (m && /\d/.test(raw.charAt(m[1].length))) {
    const glued = name.match(/^(.*\S)\s+[A-Za-z]{1,3}$/);
    if (glued && /\S\s+\S/.test(glued[1].trim())) name = glued[1];
  }
  // If no digit/slash present, the whole leading alphabetic chunk counts.
  if (!name) {
    const m2 = raw.match(/^([A-Za-z][A-Za-z .'`-]*)/);
    name = m2 ? m2[1] : "";
  }
  name = name.replace(/\s+/g, " ").trim();
  // Require at least two letters and a word boundary (avoid stray initials).
  if (!name || name.length < 2) return { rep: null, confidence: "unmatched" };

  // Must contain at least one space — single-token POs are typically junk like "REORDER".
  // (Exception: well-known single names could be added here later via a sku_crossref-like
  // table. For now we treat single tokens as unmatched.)
  if (!name.includes(" ")) return { rep: null, confidence: "unmatched" };

  return { rep: titleCase(name), confidence: "parsed" };
}
