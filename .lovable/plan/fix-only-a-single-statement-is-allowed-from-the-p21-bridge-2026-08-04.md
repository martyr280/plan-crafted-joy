# Fix: "Only a single statement is allowed" from the P21 bridge

## What is actually happening (verified, high confidence)

Verified against the live job queue:

- 42 bridge jobs in the last 3 days failed with exactly `Only a single statement is allowed`. All are `sql.select`, all slugs `sales-annualized-<repCode>`, all handled by agent `ndi-windows-01`, reported **version 1.0.0** (last seen minutes ago).
- The latest Sales Reports run recorded `51 of 51 reps failed`, every rep with that same message.
- **That error string does not exist anywhere in this codebase.** The current bridge handler (`agent/handlers/sql-select.js`) explicitly allows multiple statements and strips leading comments. So the rejection is coming from the **older agent build installed on the client's Windows box**, not from our server code. That is why previous fixes on our side didn't stop it.
- What trips the old guard: the shipped SQL contains 3 semicolons — line 91 (`...Joseph's report; NULL until confirmed.`), line 110 (`...mapping above; NULL until then.`), both inside `--` comments, and the trailing `ORDER BY ... DESC;`. The old guard counts semicolons in raw text, including inside comments, and rejects.

Also worth correcting: it is not literally firing every minute. One Sales Reports run enqueues one job per rep, 51 reps, roughly one job every 4–5 seconds, so a single run produces a rapid burst of failures that reads like a per-minute loop.

Separately, 3 jobs failed at 07:00 with `Invalid column name 'cancel_flag'` — a different, pre-existing issue, not in scope here unless you want it included.

## Fix strategy

Do not depend on the client updating the agent .exe to get unblocked. Make the SQL we ship acceptable to *both* the old and new agent guards, then update the agent as follow-up hygiene.

### 1. Sanitize SQL centrally before it leaves the server

Add a `sanitizeBridgeSql(text)` helper and apply it to every `sql.select` payload inside `runJob` in `src/lib/p21.server.ts`, so every caller (Sales Reports, truck capacity, RMA, scheduled queries, bridge console) is covered by one change:

- remove `/* ... */` blocks and `--` line comments, skipping over single-quoted string literals and `[bracketed]` identifiers so real SQL is never damaged
- collapse the resulting blank lines
- strip all trailing whitespace and semicolons

Result: the text that reaches the agent contains no semicolons and no comments, which satisfies the old 1.0.0 guard and the current one.

### 2. Keep comments out of the wire, not out of the source

Templates keep their explanatory comments in `src/lib/sales-annualized-template.ts` and elsewhere — the sanitizer strips them at send time. As belt-and-braces, rewrite the two semicolons inside those two comment lines to commas.

### 3. Make the agent-version mismatch visible

Add an agent-version line to the Bridge page's agent card and a warning when the connected agent's reported version is older than the version this app expects, with the text "this agent build rejects comments/semicolons in SQL; update recommended". Silent version drift is what made this hard to diagnose.

### 4. Bump and release the agent (follow-up, needs client install)

Bump `agent/package.json` to 1.1.0 and tag a release so the client can install a build whose guard matches the repo. Not required for the fix above to work.

## Verification

- Re-run Sales Reports for a single rep and confirm the job lands `done` with rows, not `error`.
- Confirm the stored `payload.sql` for that job has zero semicolons and no `--` comments.
- Re-check the queue for any new `Only a single statement is allowed` rows after the run.

## Technical notes

Files touched: `src/lib/p21.server.ts` (sanitizer + apply in `runJob`), `src/lib/sales-annualized-template.ts` (comment punctuation), `src/routes/_app.bridge.tsx` (version display/warning), `agent/package.json` (version bump). No schema changes, no UI behavior changes beyond the bridge version notice.
