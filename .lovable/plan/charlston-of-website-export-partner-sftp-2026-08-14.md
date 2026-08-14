# Charlston OF website export → partner SFTP

Nightly: run NDI's stored procedure, turn the result set into a CSV, drop it on the partner's SFTP server. Plus a manual "Run now" button and a dry-run that produces the file without delivering it.

## The hard constraint, up front

The Nelson app runs on Cloudflare Workers, which has no SSH/SFTP capability at all, and cannot reach NDI's SQL Server. Both halves of this job must run in the on-prem bridge agent on NDI's Windows server. That means **a new agent release and a manual install on that server** before the first file can ever be delivered. Nothing about this feature works until that install happens; the app side will report that plainly rather than pretend.

This also confirms the earlier answer about the allow-list: `142.190.99.117` must be the public egress IP of the NDI server running the agent. That needs verifying before go-live — if it is not that server's IP, delivery will fail with a connection refusal at the partner end.

## Interpreting the supplied SQL — exactly

```text
USE P21_Analytics_PLAY
EXEC Website.usp_ExportSuiteCommerceTest;
GO
```

Read literally, and each line matters:

1. **Database is `P21_Analytics_PLAY`.** The agent today binds one database via config (currently the P21 production DB). The export must open its own connection to `P21_Analytics_PLAY` — the database name becomes a setting, so a later cutover to the production analytics DB is a settings change, not a code change.
2. **It is a stored-procedure call, not a query.** This cannot use the existing `sql.select` bridge path: that handler requires the statement to begin with `SELECT`, `WITH`, or `DECLARE`, and the app strips semicolons and comments before the wire. `EXEC`, `USE`, and `GO` would all be rejected. A dedicated handler is required.
3. **`GO` is a client batch separator**, not SQL. It is not sent to the server.
4. **The procedure name is used verbatim** — `Website.usp_ExportSuiteCommerceTest`. Note it is named `...Test`. It will be stored as a setting so swapping to a production procedure is a settings edit.
5. **One result set, taken as-is.** Columns are emitted in the exact order and with the exact names the procedure returns. No renaming, reordering, filtering, or added columns.

## CSV rules (locked, so the partner gets a byte-stable file)

- Comma-delimited, one header row of the procedure's column names verbatim.
- `CRLF` line endings, UTF-8 **without** BOM.
- A field is quoted only when it contains a comma, a double quote, CR, or LF; embedded quotes are doubled (RFC 4180).
- `NULL` → empty field (not the text "NULL").
- Dates/datetimes → `YYYY-MM-DD` / `YYYY-MM-DD HH:MM:SS`; decimals → plain digits with no thousands separators, no currency symbol; booleans → `1`/`0`.
- No trailing blank line beyond the final `CRLF`.

Two items to confirm with the partner before the first live drop: their expected date format, and whether they want the header row at all. Both are settings, not code.

## Filename

`NDI_YYYYMMDD.csv` (server-local date at run time), e.g. `NDI_20260814.csv`. The pattern is a setting, so if they want a different date form or a fixed overwriting name it is a one-field change. Uploads go to `files.ndiofficefurniture.net/Charlston_OF`, written to a temp name and renamed into place on success so the partner never sees a partial file.

## What gets built

**A. Agent (new release, requires manual install)**

- New job kind `website.export.sftp`: connect to the configured analytics database, `EXEC` the configured procedure, take the last result set with its column order, render CSV per the rules above, then upload over SFTP with SSH key auth, atomic temp-then-rename.
- Adds an SSH/SFTP client dependency to the agent.
- Credentials live on the NDI server, not in the cloud: host `ssh.ndiofficefurniture.net`, port `18765`, user `u2323-uw7q3pmmnio7`, and a path to the `NDI-Charlston-Automation` private key file (plus passphrase if the key has one) go into the agent's local `.env`. The private key is never uploaded to Nelson and never stored in the database.
- Returns row count, byte size, column list, and the remote filename — never file contents.
- `dryRun: true` renders and validates the CSV, reports the stats and a small preview, and skips the upload.

**B. App**

- `web_export_runs` table: trigger (cron/manual/dry-run), status, row/byte counts, resolved filename, column list, error text, timestamps, who ran it. Admin/logistics-admin read; writes server-side only. Standard grants + RLS.
- `app_settings.website_export`: enabled flag, database name, procedure name, filename pattern, remote folder, delimiter/header/date-format options, timezone.
- Server module that enqueues the bridge job, records the run, and surfaces agent errors as run rows rather than crashes.
- Page under Reports: last-run status, run history with row counts and errors, "Run now", "Dry run", and a settings card. Role-gated in the sidebar.
- Nightly cron block added to the existing schedule route (single UTC-gated, dedup-guarded, try/caught so it cannot starve the other nightly blocks). Exact hour to be set — proposal: 09:00 UTC (~04:00 Central), after the analytics data settles.

**C. Verification order**

1. Dry run first: confirm column list and row count match what the procedure produces in SSMS, and eyeball the CSV preview.
2. Then a single live manual run and have the partner confirm the file parses.
3. Only then enable the nightly schedule.

## Sequencing

Steps A and B can be built together, but **B is testable and A is not** until the agent build is installed on the NDI server. Expect: build both → tag an agent release → install on the NDI Windows server → verify the `142.190.99.117` egress assumption → dry run → live run → enable cron.
