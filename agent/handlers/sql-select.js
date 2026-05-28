import { query } from "../sql.js";

// payload: { sql, params?, slug?, maxRows? }
// Read-only SELECT/WITH against P21. The DB login (P21_SQL_USER) should be
// db_datareader-only — that's the real safety boundary. We still do a light
// shape check so obvious mistakes fail fast.
export async function sqlSelect(payload) {
  const { sql: text, params = {}, maxRows } = payload ?? {};
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("sql is required");
  }
  const trimmed = text.trim().replace(/;\s*$/, "");
  const head = trimmed.replace(/^;\s*/, "").slice(0, 6).toLowerCase();
  if (!head.startsWith("select") && !head.startsWith("with")) {
    throw new Error("Only SELECT or WITH queries are allowed");
  }
  if (trimmed.includes(";")) {
    throw new Error("Only a single statement is allowed");
  }

  const rows = await query(text, params);
  const cap = Number.isFinite(maxRows) ? Math.max(1, Number(maxRows)) : 50000;
  const truncated = rows.length > cap;
  const out = truncated ? rows.slice(0, cap) : rows;
  return { rows: out, count: out.length, truncated };
}
