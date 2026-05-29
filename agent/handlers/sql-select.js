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
  const trimmed = text.trim().replace(/^;\s*/, "").replace(/;\s*$/, "");
  const head = trimmed.slice(0, 6).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error("Only SELECT or WITH queries are allowed");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed");
  }

  const { rows, columns } = await queryWithColumns(text, params);
  const cap = Number.isFinite(maxRows) ? Math.max(1, Number(maxRows)) : 50000;
  const truncated = rows.length > cap;
  const out = truncated ? rows.slice(0, cap) : rows;
  // `columns` preserves SELECT order; rows are an array (order preserved
  // through jsonb). Object keys inside each row will NOT survive jsonb
  // round-trip — consumers must use `columns` for column ordering.
  return { rows: out, columns, count: out.length, truncated };
}
