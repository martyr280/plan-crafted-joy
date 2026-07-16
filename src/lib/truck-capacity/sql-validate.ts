// Truck Capacity :: P21 SQL output validators.
//
// Two layers, both server-only:
//   1. validateP21SqlText(sql)   — cheap textual check that the SELECT list
//      exposes the required column aliases. Called on save (before we let an
//      admin persist a broken query) and again before we ship the query to
//      the P21 bridge on Test / Run.
//   2. validateP21SqlOutput(rows, kind) — inspects the first N rows the bridge
//      actually returned and confirms column presence + per-cell types. Called
//      after Test / Run pulls rows, before the matcher runs. Runtime failures
//      here are the ones that would silently corrupt truck_capacity_p21_demand
//      (nulls where numbers should be, ship_date that won't parse, etc.).
//
// Both return `{ errors, warnings }` shaped results. Callers throw on errors
// and surface warnings verbatim (empty result set, unexpected extra columns).

export type SnapshotKind = "orders" | "transfers";

export type SqlValidation = { errors: string[]; warnings: string[] };

// Columns that MUST appear as SELECT aliases (case-insensitive) and MUST be
// present as keys on every returned row. Same list for orders + transfers —
// the transfer query maps its own concepts onto the same contract.
const REQUIRED_COLUMNS = [
  "route_code",
  "ship_date",
  "order_count",
  "total_weight_lbs",
  "total_cube_ft",
] as const;

// Optional columns. `est_pallets` is optional because NDI's inv_mast has no
// per-item pallet count — the snapshot treats a missing column as NULL and
// falls back to weight/cube ratios. `ship_city/state/zip` are used by the
// resolver to disambiguate shared route codes.
const OPTIONAL_COLUMNS = ["ship_city", "ship_state", "ship_zip", "est_pallets"] as const;

const KNOWN_COLUMNS = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

/**
 * Textual check. Strips comments + string literals, then confirms each
 * required alias appears as a whole-word token. This is a smell test, not
 * a parser — it catches "the admin forgot est_pallets" and "the admin
 * renamed route_code to route" without needing to execute the query.
 */
export function validateP21SqlText(sql: string, _kind: SnapshotKind = "orders"): SqlValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = String(sql ?? "");
  if (!raw.trim()) {
    errors.push("SQL is empty.");
    return { errors, warnings };
  }
  // Strip block comments, line comments, then single/double-quoted string
  // literals so an alias that only appears inside a comment doesn't count.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'([^'\\]|\\.|'')*'/g, " ' ' ")
    .replace(/"([^"\\]|\\.|"")*"/g, ' " " ');
  const lower = stripped.toLowerCase();
  for (const col of REQUIRED_COLUMNS) {
    // Match `col` as a whole word OR `as col` / `as "col"` — SQL Server
    // sometimes emits the alias without an explicit AS. Whole-word regex
    // covers both cases since we've already collapsed quoted identifiers.
    const re = new RegExp(`(^|[^a-z0-9_])${col}([^a-z0-9_]|$)`, "i");
    if (!re.test(lower)) {
      errors.push(`Required output column \`${col}\` is not referenced in the SELECT list.`);
    }
  }
  return { errors, warnings };
}

/** Coerce loosely-typed cell values the way the snapshot matcher does. */
function isNumeric(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "");
    if (!cleaned) return false;
    const n = Number(cleaned);
    return Number.isFinite(n);
  }
  return false;
}

function isNumericOrNull(v: unknown): boolean {
  return v === null || v === undefined || v === "" || isNumeric(v);
}

function isParseableDate(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  const s = String(v).trim();
  if (!s) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

function isStringLike(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number";
}

/**
 * Runtime check against the rows the bridge actually returned. Inspects up
 * to `sampleLimit` rows; caller decides whether to reject or downgrade
 * findings to warnings.
 */
export function validateP21SqlOutput(
  rows: unknown[],
  _kind: SnapshotKind = "orders",
  sampleLimit = 25,
): SqlValidation {
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

  // Column presence is checked against the first row (bridge returns
  // homogeneous rows). Per-cell type checks then run against the sample.
  const first = rows[0];
  if (!first || typeof first !== "object") {
    errors.push("First row is not an object — the bridge should return row objects keyed by column alias.");
    return { errors, warnings };
  }
  const keys = new Set(Object.keys(first as Record<string, unknown>).map((k) => k.toLowerCase()));
  for (const col of REQUIRED_COLUMNS) {
    if (!keys.has(col)) errors.push(`Missing required output column \`${col}\` on returned rows.`);
  }
  // Note (not error) when the query returns columns we don't consume — admins
  // sometimes tack on debug fields; harmless but worth flagging.
  const extras = Object.keys(first as Record<string, unknown>).filter(
    (k) => !KNOWN_COLUMNS.has(k.toLowerCase()),
  );
  if (extras.length > 0) {
    warnings.push(`Query returned unused columns (ignored by the matcher): ${extras.slice(0, 10).join(", ")}${extras.length > 10 ? "…" : ""}.`);
  }
  // If required columns are missing, don't bother with cell-level checks —
  // the caller has enough to reject.
  if (errors.length > 0) return { errors, warnings };

  const sample = rows.slice(0, sampleLimit) as Array<Record<string, unknown>>;
  // Track distinct issues per column so we don't spam N copies of the same
  // problem when every row is broken the same way.
  const seen = new Set<string>();
  const flag = (msg: string) => { if (!seen.has(msg)) { seen.add(msg); errors.push(msg); } };

  for (let i = 0; i < sample.length; i++) {
    const r = sample[i];
    const rc = r.route_code;
    if (rc === null || rc === undefined || String(rc).trim() === "") {
      flag("`route_code` is null/empty on at least one row — every row must carry a route code.");
    } else if (typeof rc !== "string" && typeof rc !== "number") {
      flag("`route_code` must be a string (got a non-scalar).");
    }
    if (!isParseableDate(r.ship_date)) {
      flag("`ship_date` on at least one row is not a parseable date — return CAST(... AS DATE) or an ISO string.");
    }
    if (!isNumeric(r.order_count)) {
      flag("`order_count` must be numeric on every row (got null/blank/non-numeric).");
    }
    if (!isNumericOrNull(r.total_weight_lbs)) flag("`total_weight_lbs` must be numeric or NULL.");
    if (!isNumericOrNull(r.total_cube_ft))    flag("`total_cube_ft` must be numeric or NULL.");
    if (!isNumericOrNull(r.est_pallets))      flag("`est_pallets` must be numeric or NULL.");

    if ("ship_city" in r && r.ship_city != null && !isStringLike(r.ship_city)) {
      flag("`ship_city` must be a string or NULL when returned.");
    }
    if ("ship_state" in r && r.ship_state != null) {
      const s = String(r.ship_state).trim();
      if (s && !/^[A-Za-z]{2}$/.test(s)) {
        warnings.push(`\`ship_state\` value ${JSON.stringify(r.ship_state)} is not a 2-letter code — the resolver will ignore it.`);
      }
    }
    if ("ship_zip" in r && r.ship_zip != null) {
      const digits = String(r.ship_zip).match(/\d/g)?.join("") ?? "";
      if (digits.length < 5) {
        warnings.push(`\`ship_zip\` value ${JSON.stringify(r.ship_zip)} has fewer than 5 digits — the resolver will ignore it.`);
      }
    }
  }

  // Sanity: if every sampled row has null capacity signals, the matcher will
  // silently drop all inserts (no ratio computable). Warn loudly.
  const allCapacityNull = sample.every(
    (r) => !isNumeric(r.total_weight_lbs) && !isNumeric(r.total_cube_ft) && !isNumeric(r.est_pallets),
  );
  if (allCapacityNull) {
    warnings.push("Every sampled row has NULL weight, cube, AND pallets — the matcher will drop all rows because no capacity ratio can be computed.");
  }

  return { errors, warnings };
}
