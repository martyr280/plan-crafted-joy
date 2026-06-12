## Problem

The scheduled "E2G Combined Report" emails a **CSV** attachment, but the canonical/expected format (per the uploaded `NDI-E2G-20260528.xlsx`) is an **XLSX** with proper data types:

- `Today` → real datetime cell
- `Birm`, `Dallas`, `Ocala`, `Total` → numeric cells (currently the SQL CASTs them to VARCHAR, so even the CSV is all-strings)
- `E2G Price`, `weight`, `net_weight` → numeric
- `Next Due In` / `Next Due In 2` → blank when no due date (not `""`)
- 12 columns in this exact order: `item_id, Today, item_desc, Birm, Dallas, Ocala, Total, E2G Price, weight, net_weight, Next Due In, Next Due In 2`

The SQL itself already produces the right columns in the right order, so the fix is on the email/output side, not the query.

## Fix

Update `src/lib/sql-schedules.server.ts` to emit an **XLSX** attachment for email schedules, with proper cell types, and drop the SQL-side `CAST … AS VARCHAR` for the numeric location columns so they arrive as numbers.

### Changes

1. **`src/lib/sql-schedules.server.ts`**
   - Add `exceljs` (or `xlsx`) based workbook builder `toXlsx(rows, columns)`:
     - Header row = `columns` (preserves SELECT order).
     - For each cell: if value is a JS `Date` or ISO date string → write as date with `mm/dd/yyyy` or `m/d/yy h:mm` number format (matching the sample); if value is numeric (or numeric-looking string) → write as number; otherwise string; `null`/`undefined` → empty cell.
     - Auto-size columns roughly (max(header, sample widths)).
     - Freeze header row, bold header.
   - Replace the `sendEmailWithCsv` call with `sendEmailWithXlsx`:
     - `filename`: `${name}-${YYYY-MM-DD}.xlsx`
     - `content-type` handled by Resend via filename extension; base64 body unchanged.
   - Keep CSV helper for now but stop using it from `executeSchedule`.

2. **`agent/handlers/e2g-report.js`**
   - Remove the `CAST(... AS VARCHAR(20))` wrappers for `Birm`, `Dallas`, `Ocala`, `Total`, `E2G Price`, `weight`, `net_weight` so those come back as real numbers from MSSQL.
   - Keep the `'Kit - NA'` literal for kit rows — that column will then be mixed (number for regular, string for kits), which matches the uploaded xlsx exactly (where Birm/Dallas/Ocala show numbers for regular rows and would show `Kit - NA` for kit rows).
   - Keep `Next Due In` / `Next Due In 2` as the existing `CONVERT(VARCHAR…)` display strings; just stop coercing `''` — let SQL return `NULL` when no due date so the xlsx cell is blank (sample shows `NaN`/blank, not `""`).

3. **Dependency**
   - Add `exceljs` via `bun add exceljs` (pure JS, Workers-compatible, supports streaming write to Buffer).

4. **Verification**
   - Trigger the schedule via the existing "Run now" button on `/sql-schedules` and open the resulting email attachment to confirm:
     - File extension `.xlsx`
     - Numeric columns sortable as numbers
     - `Today` shows as a real date
     - `Next Due In` blank when not applicable
     - Column order matches the sample exactly.

### Non-goals

- No changes to the SQL logic (joins, filters, kit math) — only the trailing `CAST`s for presentation.
- No changes to the `upsert_price_list` action.
- No UI changes on `/sql-schedules`.

### Technical notes

- `exceljs` works in the Cloudflare Worker runtime (pure JS, no native deps) and can produce a Buffer via `workbook.xlsx.writeBuffer()` which we base64 for Resend attachments.
- Agent change ships via the next `agent-release.yml` build; the bridge is on-prem so the customer will need to update the agent for the numeric columns to flow through. Until then, the xlsx will still render — values just stay as strings in the four location columns. We can ship the email-side XLSX change immediately and the agent change in the same PR.
