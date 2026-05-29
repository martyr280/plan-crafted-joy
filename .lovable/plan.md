# Scheduled SQL Queries

Add a unified scheduling layer on top of the existing P21 SQL console so admins can:

1. **Schedule the pricer query** (or any SQL) to run on a cron and push results into `price_list`.
2. **Schedule arbitrary report queries** to run on a cron and email the results (CSV) to a recipient list.

Today the pricer query *is* scheduled via GitHub Actions (nightly 06:30 UTC) hitting `/api/public/sync-pricer`, but it's invisible in the app and not editable. The other half (arbitrary report SQL + email) doesn't exist.

## New table — `sql_schedules`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | "Nightly pricer sync", "AR > 90 weekly", etc. |
| description | text | optional |
| sql | text | single SELECT/WITH, validated like the console |
| params | jsonb | bound `@name` values |
| action | text | `email` \| `upsert_price_list` |
| recipients | jsonb (text[]) | only used when action='email' |
| email_subject | text | template; `{{name}}`, `{{rows}}`, `{{date}}` |
| schedule_cron | text | standard 5-field cron |
| timezone | text | default `America/New_York` |
| active | boolean | |
| next_run_at | timestamptz | computed from cron on save / after each run |
| last_run_at, last_status, last_row_count, last_error | | |
| created_at/updated_at/created_by | | |

RLS: admin-only (matches existing P21 patterns). GRANT to authenticated + service_role.

`next_run_at` computed via `cron-parser` (new dep) in server fns.

## Server functions — `src/lib/sql-schedules.functions.ts`

- `listSqlSchedules()` – admin only
- `upsertSqlSchedule({...})` – validates SQL (SELECT/WITH, single statement, no `;`), computes `next_run_at`
- `deleteSqlSchedule({id})`
- `runSqlScheduleNow({id})` – executes immediately, records result
- `previewSqlSchedule({sql, params})` – dry-run via the existing `sql.select` bridge job

Shared executor (`src/lib/sql-schedules.server.ts`):
- `executeSchedule(scheduleId)` → run `sql.select` job → branch on action:
  - **upsert_price_list**: re-use the existing `applyPricerSync()` path (which already maps the pricer columns into `price_list`). For the canonical pricer query we just call `applyPricerSync()`; for any other future `upsert_price_list` schedule the SQL must return the same columns the handler expects.
  - **email**: render rows to CSV, attach, POST to Resend via `process.env.RESEND_API_KEY`. Subject template gets `{{name}}`, `{{date}}`, `{{rows}}` interpolation. Skip send if `rows.length === 0` unless `send_when_empty` flag (defer for now — always send).
- Records `last_run_at/last_status/last_row_count/last_error`, recomputes `next_run_at`, logs `activity_events`.

## Public cron tick endpoint — `src/routes/api/public/run-sql-schedules.ts`

- `POST` with `Authorization: Bearer $CRON_SECRET`
- Selects `active=true AND next_run_at <= now()`, runs each through `executeSchedule`, returns summary.
- Scheduled via pg_cron every minute (set up via the supabase insert tool).

```sql
SELECT cron.schedule(
  'sql-schedules-tick','* * * * *',
  $$ SELECT net.http_post(
    url:='https://project--8f98c139-...lovable.app/api/public/run-sql-schedules',
    headers:='{"Authorization":"Bearer <CRON_SECRET>","Content-Type":"application/json"}'::jsonb,
    body:='{}'::jsonb
  ); $$
);
```

(The existing GitHub Actions pricer cron can stay or be retired once a `sql_schedules` row exists for it — I'll seed that row and leave both wired for now to avoid a coverage gap.)

## UI

New route `src/routes/_app.bridge.schedules.tsx` (or a tab inside Bridge), reachable from the SQL console with a **"Save as scheduled query"** button that prefills name/SQL/params.

Table columns: name · action · cron · next run · last run / status · recipients · row count · actions (Run now / Edit / Delete / pause toggle).

Editor dialog: name, description, action, recipients (chip input — only when action=email), cron + helper presets (hourly, 06:00 daily, Monday 08:00), timezone, the SQL + params editors (re-using the existing console fields), "Test run" button (calls `previewSqlSchedule`).

Also add a small **"Schedules"** card on `/bridge` showing the next 5 upcoming runs.

## Dependency

`bun add cron-parser` (pure JS, Worker-safe).

## Out of scope (this pass)

- Webhook delivery / Slack
- Per-recipient role filtering (recipients are explicit emails)
- HTML formatted report bodies beyond CSV attachment
- Result history retention / drill-down beyond the last run

## Files touched

- migration: `sql_schedules` table + RLS + grants
- `src/lib/sql-schedules.functions.ts` (new)
- `src/lib/sql-schedules.server.ts` (new)
- `src/routes/api/public/run-sql-schedules.ts` (new)
- `src/routes/_app.bridge.schedules.tsx` (new)
- `src/routes/_app.bridge.tsx` (link + "Save as schedule" button on console)
- `package.json` (`cron-parser`)
- supabase insert for pg_cron job

After approval I'll run the migration first, then build the rest.