## Problem

Two real bugs with scheduled SQL queries:

1. **Multiple statements are blocked.** Both `validateSelectSql` (server) and `sqlSelect` (agent) reject any SQL containing `;`. That blocks legitimate multi-statement scripts that work in the editor — e.g. `DECLARE @x ...; WITH cte AS (...) SELECT ...;` or a setup SELECT followed by a final output SELECT.
2. **Column order in the preview table is wrong.** The agent already returns `columns` in SELECT order, and the CSV/XLSX path honors it — but the preview table in `ScheduleEditor` builds its header from `Object.keys(previewRows[0])`, which loses order when rows round-trip through Postgres `jsonb`. So the preview shows columns in scrambled order even though the email attachment is already correct.

The user wants: allow multiple statements; the LAST recordset is treated as the output; preview honors the server-declared column order.

## Changes

### A. Allow multiple statements (agent + server)
- `agent/handlers/sql-select.js`: drop the `if (trimmed.includes(";"))` check. Keep the head check (first non-whitespace token must be `SELECT` or `WITH`). Safety boundary remains the DB user (`db_datareader` only), as the comment already notes.
- `src/lib/sql-schedules.server.ts` → `validateSelectSql`: same — remove the `;` check, keep the head check.

### B. Return the LAST recordset (agent)
- `agent/sql.js` → `queryWithColumns`: when `result.recordsets` has length > 1, pick the last recordset that has a `columns` metadata bag (or the last non-empty one as fallback). Use `Object.keys(rs.columns)` from that specific recordset for `columns`, and that recordset's rows for `rows`. This matches the user's mental model — "the second query outputs the data" — and is how SSMS shows the final grid.

### C. Fix preview column order (UI)
- `src/routes/_app.sql-schedules.tsx` → `ScheduleEditor`:
  - Track `previewColumns` from the server response (`previewSqlSchedule` already returns `columns`).
  - Replace `const columns = useMemo(... Object.keys(previewRows[0]))` with the server-provided `previewColumns` (fallback to `Object.keys` only if the server didn't send any).

No DB schema changes. No cron changes. The CSV/XLSX email attachment path is already correct — this just makes the preview and multi-statement support match.

## Technical notes

- `mssql` exposes all result sets on `result.recordsets` (array of recordsets, each with its own `.columns` metadata). `result.recordset` is just `recordsets[recordsets.length - 1]` historically, but for safety we'll iterate `recordsets` and prefer the last one whose `columns` is populated.
- Removing the `;` ban does not weaken security: the SQL bridge connects with a read-only login, and `validateSelectSql` still requires the script to begin with `SELECT` or `WITH`. Any `INSERT/UPDATE/DELETE/EXEC` issued by the user would fail at the DB with a permissions error.
