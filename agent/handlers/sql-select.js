import { queryWithColumns } from "../sql.js";

// payload: { sql, params?, slug?, maxRows? }
// Read-only SELECT/WITH against P21. The DB login (P21_SQL_USER) should be
// db_datareader-only — that's the real safety boundary. We still do a light
// shape check so obvious mistakes fail fast.
export async function sqlSelect(payload) {
  const { sql: text, params = {}, maxRows } = payload ?? {};
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("sql is required");
  }
  // Strip leading `--` line comments and `/* ... */` block comments plus
  // leading whitespace/semicolons before the shape check, so a query
  // prefixed with an explanatory header still passes.
  let head = text;
  for (;;) {
    const before = head;
    head = head.replace(/^\s+/, "");
    head = head.replace(/^;+\s*/, "");
    head = head.replace(/^--[^\n]*\n?/, "");
    head = head.replace(/^\/\*[\s\S]*?\*\//, "");
    if (head === before) break;
  }
  const firstToken = head.slice(0, 6).toLowerCase();
  if (!firstToken.startsWith("select") && !firstToken.startsWith("with") && !firstToken.startsWith("declar")) {
    throw new Error("Query must begin with SELECT, WITH, or DECLARE");
  }
  // Multiple statements are allowed — the DB user is db_datareader-only,
  // so any write attempt fails at the server. The last recordset is treated
  // as the output (matches SSMS behavior).

  const { rows, columns } = await queryWithColumns(text, params);
  const cap = Number.isFinite(maxRows) ? Math.max(1, Number(maxRows)) : 50000;
  const truncated = rows.length > cap;
  const out = truncated ? rows.slice(0, cap) : rows;
  // `columns` preserves SELECT order; rows are an array (order preserved
  // through jsonb). Object keys inside each row will NOT survive jsonb
  // round-trip — consumers must use `columns` for column ordering.
  return { rows: out, columns, count: out.length, truncated };
}
