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
