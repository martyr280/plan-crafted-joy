import { query } from "../sql.js";

const MAX_ROWS = 50000;

// Defense-in-depth read-only guard. This catches mistakes and obvious abuse,
// but it is NOT the real security boundary — `P21_SQL_USER` MUST be a
// db_datareader-only SQL login. A read-only login cannot mutate P21 even if
// this guard were bypassed. See agent/README.md.
function assertReadOnly(rawSql) {
  let s = String(rawSql)
    .replace(/\/\*[\s\S]*?\*\//g, " ") // strip /* block comments */
    .replace(/--[^\n]*/g, " ") // strip -- line comments
    .trim()
    .replace(/^;\s*/, "") // tolerate the leading ";WITH" T-SQL idiom
    .replace(/;\s*$/, ""); // tolerate a single trailing semicolon

  if (s.includes(";")) {
    throw new Error("Only a single statement is allowed (no ';' inside the query).");
  }
  if (!/^(select|with)\b/i.test(s)) {
    throw new Error("Only SELECT / WITH queries are allowed.");
  }
  const banned = s.match(
    /\b(insert|update|delete|drop|alter|truncate|merge|create|grant|revoke|exec|execute|backup|restore|shutdown|reconfigure)\b/i,
  );
  if (banned) {
    throw new Error(`Disallowed keyword in query: ${banned[0].toUpperCase()}`);
  }
  // SELECT ... INTO <table> materializes a new table — block it.
  if (/\binto\b/i.test(s)) {
    throw new Error("SELECT ... INTO is not allowed.");
  }
  return s;
}

// payload: { sql: string, params?: Record<string, any>, slug?: string }
// `slug` is informational only (audit trail of which catalog entry ran).
export async function sqlSelect(payload) {
  const { sql, params = {} } = payload ?? {};
  if (!sql || typeof sql !== "string") {
    throw new Error("payload.sql (string) is required");
  }
  const clean = assertReadOnly(sql);
  const rows = await query(clean, params ?? {});
  if (rows.length > MAX_ROWS) {
    return { rows: rows.slice(0, MAX_ROWS), count: rows.length, truncated: true };
  }
  return { rows, count: rows.length, truncated: false };
}
