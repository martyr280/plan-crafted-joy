// RMA Analytics :: P21 SQL output validators.
//
// Same two-layer shape as truck-capacity/sql-validate.ts:
//   1. validateRmaSqlText(sql)      — cheap textual check that the SELECT list
//      exposes the required column aliases. Run on save and again before we
//      ship the query to the bridge.
//   2. validateRmaSqlOutput(rows)   — inspects the rows the bridge actually
//      returned and confirms column presence + per-cell types before anything
//      lands in rma_snapshot_rows.
//
// Server-only by convention (pure functions, no imports) so both the
// *.functions.ts auth layer and the snapshot runner can call them.

export type SqlValidation = { errors: string[]; warnings: string[] };

// Columns that MUST appear as SELECT aliases and MUST be present on every
// returned row. Deliberately minimal: the attribution dimensions (driver,
// picker, route, warehouse) are OPTIONAL because NDI's exact P21 RMA schema
// still needs verification — a snapshot that only carries reason codes and
// dealers is still useful, and the UI degrades per-dimension.
export const REQUIRED_COLUMNS = ["rma_no", "rma_date", "qty", "value", "reason_code"] as const;

export const OPTIONAL_COLUMNS = [
  "customer_id",
  "customer_name",
  "order_no",
  "invoice_no",
  "item_id",
  "item_desc",
  "reason_desc",
  "route_code",
  "driver_name",
  "picker_name",
  "warehouse_id",
] as const;

const KNOWN_COLUMNS = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

// Attribution dimensions the ATTRIBUTION tab depends on. Missing ones are
// warnings, not errors — surfaced so the admin knows which breakdown will be
// empty before they commit the query.
const ATTRIBUTION_COLUMNS = ["driver_name", "picker_name", "route_code", "customer_id"] as const;

export function validateRmaSqlText(sql: string): SqlValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = String(sql ?? "");
  if (!raw.trim()) {
    errors.push("SQL is empty.");
    return { errors, warnings };
  }
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'([^'\\]|\\.|'')*'/g, " ' ' ")
    .replace(/"([^"\\]|\\.|"")*"/g, ' " " ');
  const lower = stripped.toLowerCase();
  const mentions = (col: string) =>
    new RegExp(`(^|[^a-z0-9_])${col}([^a-z0-9_]|$)`, "i").test(lower);

  for (const col of REQUIRED_COLUMNS) {
    if (!mentions(col)) {
      errors.push(`Required output column \`${col}\` is not referenced in the SELECT list.`);
    }
  }
  const missingDims = ATTRIBUTION_COLUMNS.filter((c) => !mentions(c));
  if (missingDims.length > 0) {
    warnings.push(
      `Attribution columns not referenced: ${missingDims.join(", ")}. Those breakdowns will be empty in RMA Analytics.`,
    );
  }
  return { errors, warnings };
}

function isNumeric(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s()]/g, "");
    if (!cleaned) return false;
    return Number.isFinite(Number(cleaned));
  }
  return false;
}

function isNumericOrNull(v: unknown): boolean {
  return v === null || v === undefined || v === "" || isNumeric(v);
}

function isParseableDate(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  const d = new Date(String(v).trim());
  return !Number.isNaN(d.getTime());
}

export function validateRmaSqlOutput(rows: unknown[], sampleLimit = 25): SqlValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(rows)) {
    errors.push("Query result is not an array of rows.");
    return { errors, warnings };
  }
  if (rows.length === 0) {
    warnings.push("Query returned 0 rows — output column contract could not be verified against real data.");
    return { errors, warnings };
  }
  const first = rows[0];
  if (!first || typeof first !== "object") {
    errors.push("First row is not an object — the bridge should return row objects keyed by column alias.");
    return { errors, warnings };
  }
  const keys = new Set(Object.keys(first as Record<string, unknown>).map((k) => k.toLowerCase()));
  for (const col of REQUIRED_COLUMNS) {
    if (!keys.has(col)) errors.push(`Missing required output column \`${col}\` on returned rows.`);
  }
  const missingDims = ATTRIBUTION_COLUMNS.filter((c) => !keys.has(c));
  if (missingDims.length > 0) {
    warnings.push(`Rows carry no ${missingDims.join(", ")} — those attribution breakdowns will be empty.`);
  }
  const extras = Object.keys(first as Record<string, unknown>).filter(
    (k) => !KNOWN_COLUMNS.has(k.toLowerCase()),
  );
  if (extras.length > 0) {
    warnings.push(
      `Query returned unused columns (kept only in \`raw\`): ${extras.slice(0, 10).join(", ")}${extras.length > 10 ? "…" : ""}.`,
    );
  }
  if (errors.length > 0) return { errors, warnings };

  const sample = rows.slice(0, sampleLimit) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const flag = (msg: string) => {
    if (!seen.has(msg)) { seen.add(msg); errors.push(msg); }
  };
  let blankReasons = 0;
  for (const r of sample) {
    if (r.rma_no === null || r.rma_no === undefined || String(r.rma_no).trim() === "") {
      flag("`rma_no` is null/empty on at least one row — every row must carry an RMA number.");
    }
    if (!isParseableDate(r.rma_date)) {
      flag("`rma_date` on at least one row is not a parseable date — return CAST(... AS DATE) or an ISO string.");
    }
    if (!isNumericOrNull(r.qty)) flag("`qty` must be numeric or NULL.");
    if (!isNumericOrNull(r.value)) flag("`value` must be numeric or NULL.");
    if (r.reason_code === null || r.reason_code === undefined || String(r.reason_code).trim() === "") {
      blankReasons++;
    }
  }
  if (blankReasons === sample.length) {
    warnings.push("Every sampled row has a blank `reason_code` — the reason-code mix and outlier flags will be meaningless.");
  } else if (blankReasons > 0) {
    warnings.push(`${blankReasons} of ${sample.length} sampled rows have a blank \`reason_code\` (bucketed as "other").`);
  }
  return { errors, warnings };
}
