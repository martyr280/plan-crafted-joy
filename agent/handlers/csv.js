// Deterministic CSV rendering for partner file deliveries.
//
// Rules (locked with the partner — see plan):
//   * comma-delimited (configurable), one header row of the source column
//     names verbatim, in the exact order the result set returned them
//   * CRLF line endings, UTF-8 WITHOUT BOM
//   * a field is quoted only when it contains the delimiter, a double quote,
//     CR or LF; embedded quotes are doubled (RFC 4180)
//   * NULL/undefined -> empty field (never the text "NULL")
//   * dates -> YYYY-MM-DD, datetimes -> YYYY-MM-DD HH:MM:SS (UTC components,
//     matching mssql's useUTC default)
//   * decimals -> plain digits, no thousands separator, no currency symbol
//   * booleans -> 1 / 0
//   * exactly one trailing CRLF after the last row, no extra blank line

const pad = (n, w = 2) => String(n).padStart(w, "0");

function fmtDate(d, dateOnly) {
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  if (dateOnly) return `${y}-${m}-${day}`;
  return `${y}-${m}-${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function fmtNumber(n) {
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // Avoid scientific notation reaching the partner's parser.
  return n.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Format one cell. `declaration` is the SQL Server type name from mssql's
 * column metadata (e.g. "date", "datetime", "decimal") when available — it is
 * the only reliable way to tell a DATE column from a midnight DATETIME.
 */
export function formatCell(v, declaration) {
  if (v === null || v === undefined) return "";
  const decl = String(declaration ?? "").toLowerCase();
  if (v instanceof Date) {
    const dateOnly = decl === "date"
      || (!decl && v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0);
    return fmtDate(v, dateOnly);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return fmtNumber(v);
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function quote(field, delimiter) {
  if (field === "") return "";
  if (
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes("\r") ||
    field.includes("\n")
  ) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * rows: array of row objects. columns: column names in output order.
 * types: optional { [column]: sqlTypeDeclaration }.
 */
export function renderCsv(rows, columns, { delimiter = ",", header = true, types = {} } = {}) {
  const lines = [];
  if (header) lines.push(columns.map((c) => quote(String(c), delimiter)).join(delimiter));
  for (const row of rows) {
    lines.push(
      columns.map((c) => quote(formatCell(row?.[c], types[c]), delimiter)).join(delimiter),
    );
  }
  return lines.join("\r\n") + (lines.length ? "\r\n" : "");
}
