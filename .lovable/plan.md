## Goal

Add the E2G Combined Report (the verbatim SQL used by `agent/handlers/e2g-report.js`) as a row in `sql_schedules` so it shows up at `/sql-schedules`, ready to be turned on with a schedule + recipients.

## What I'll do

1. Insert a new `sql_schedules` row via the data tool (not a migration — this is data, not schema):
   - **name:** `E2G Combined Report`
   - **description:** "Per-item on-hand by branch (Birm/Dallas/Ocala), E2G price, weight, and next-due date from open POs. Source: agent/handlers/e2g-report.js."
   - **sql:** the full CTE from `e2g-report.js`, with `USE P21;` and the trailing `;` stripped so it passes `validateSelectSql` (single statement, must start with `select`/`with`). The agent's SQL connection is already pinned to the P21 database, so `USE P21;` is redundant.
   - **action:** `email`
   - **recipients:** `[]` (you left this blank — fill in at `/sql-schedules` before activating)
   - **email_subject:** `E2G Combined Report — {{date}}`
   - **schedule_cron:** `0 7 * * 1-5` (placeholder; you'll pick the real cadence in the UI)
   - **timezone:** `America/New_York`
   - **active:** `false` — won't run until you set recipients and toggle it on
   - **next_run_at:** `null`
   - **created_by:** your user id

2. No code changes. The existing builder UI in `/sql-schedules` already supports editing every field (schedule, recipients, run-now, activate).

## How to finish

Open `/sql-schedules`, click the new "E2G Combined Report" row:
- Add recipients
- Pick frequency in the builder (weekday/daily/etc.)
- Optionally "Run now" to verify it returns rows and emails out
- Flip Active on

## Technical notes

- `validateSelectSql` allows queries starting with `select` or `with` and forbids embedded `;`. The E2G query starts with `;WITH` — the leading `;` is stripped by the validator, and there are no other semicolons in the body, so it will pass once `USE P21;` and the trailing `;` are removed.
- Preview/Run goes through `runJob("sql.select", ...)` → the local P21 agent's `sql-select` handler, same path used by the SQL Console.
- Result set is ~all SKUs (likely 10k+ rows) → emitted as a CSV attachment by `sendEmailWithCsv`. No row-cap concerns.
