// Pure helpers for the SPIFF workbook (no ExcelJS): summary exclusion rows that
// reconcile to the excluded total, and unique Excel-safe sheet names.

export type SummaryLine = { included: boolean; exclusion_reason?: string | null };
export type SummaryRule = { code: string; label: string };
export type SummaryRow = { label: string; value: number | string; bold?: boolean; key?: string };

export const RULE_REASON_KEY: Record<string, string> = {
  invoiced_only: "not_invoiced",
  no_returns_credits: "return_credit",
  no_quotes: "quote",
  no_cancelled: "cancelled",
  no_samples: "sample",
  no_catalogs: "catalog",
};

const EXTRA_LABELS: Record<string, string> = {
  out_of_scope: "Outside the program's product scope",
  special_order: "Special orders excluded",
  missing_product_group: "Missing product group",
  unspecified: "Excluded (no reason recorded)",
};

export function reasonKey(r: string | null | undefined): string {
  const s = (r ?? "").trim();
  return s === "" ? "unspecified" : s;
}

export function countExclusionReasons(lines: SummaryLine[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of lines) {
    if (l.included) continue;
    const k = reasonKey(l.exclusion_reason);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** Rule rows, then Manually excluded, then every remaining reason, then a bold Total excluded. */
export function buildSummaryExclusionRows(rules: SummaryRule[], lines: SummaryLine[]): SummaryRow[] {
  const counts = countExclusionReasons(lines);
  const used = new Set<string>();
  const rows: SummaryRow[] = [];
  for (const rule of rules) {
    if (rule.code === "quarter_basis_invoice_date") {
      rows.push({ label: rule.label, value: "n/a (basis rule)" });
      continue;
    }
    const key = RULE_REASON_KEY[rule.code] ?? rule.code;
    // A second rule mapping to an already-shown reason must not count it twice.
    const value = used.has(key) ? 0 : Number(counts[key] ?? 0);
    used.add(key);
    rows.push({ label: rule.label, value, key });
  }
  if (!used.has("manual") && (counts.manual ?? 0) > 0) {
    rows.push({ label: "Manually excluded", value: counts.manual, key: "manual" });
    used.add("manual");
  }
  for (const [key, n] of Object.entries(counts)) {
    if (n <= 0 || used.has(key)) continue;
    rows.push({ label: EXTRA_LABELS[key] ?? `Excluded: ${key}`, value: n, key });
    used.add(key);
  }
  const included = lines.filter((l) => l.included).length;
  rows.push({ label: "Total excluded", value: lines.length - included, bold: true, key: "total" });
  return rows;
}

/** Excel-safe, unique (case-insensitive, against `taken`), ≤31 chars; appends ~2, ~3… on
 *  collision; never empty, never the Excel-reserved "History". Seed `taken` with "summary". */
export function uniqueSheetName(raw: string, taken: Set<string>): string {
  let base = String(raw ?? "").replace(/[\\/?*[\]:]/g, "_").slice(0, 31).replace(/^'+|'+$/g, "");
  if (base === "" || base.toLowerCase() === "history") base = base === "" ? "Sheet" : "History_";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = `~${n}`;
    name = base.slice(0, 31 - suffix.length).replace(/'+$/g, "") + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}
