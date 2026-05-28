## Goal
Add a SQL console to the Bridge page so admins can run ad-hoc read-only queries against P21 using the already-deployed `sql.select` agent handler.

## Backend — `src/lib/p21.functions.ts`
Add `runP21Sql` server function (admin-only via `assertAdmin`):

- Zod input: `{ sql: string (1..20000), params?: Record<string, string|number|boolean|null>, maxRows?: number (1..50000) }`
- Light client-side guardrail (server agent is the real enforcer): trim sql, require it to start with `select` or `with` (case-insensitive, allow leading `;`), reject if it contains `;` other than a single trailing one.
- Calls `runJob("sql.select", { sql, params, slug: "adhoc" }, 60000)`.
- Returns `{ rows, count, truncated }` from the job result, optionally sliced to `maxRows`.

No agent or migration changes — the handler, registration, and `p21_bridge_jobs` plumbing already exist.

## UI — `src/routes/_app.bridge.tsx`
New "SQL console" `Card` placed above "Recent jobs":

- Monospace `Textarea` (min-h ~180px) for the query, with placeholder showing `SELECT TOP 50 * FROM inv_mast WHERE item_id = @item` and a hint line explaining `@name` params bind from the JSON below.
- Small JSON `Textarea` for params (optional, parsed with try/catch — show inline error if invalid).
- `Input type="number"` for "Max rows" (default 200, max 50000).
- "Run query" button (disabled while running, shows spinner). Ctrl/Cmd+Enter also triggers run.
- "Recent queries" dropdown sourced from `localStorage` key `p21.sql.recent` (last 10, dedup by sql). Selecting one loads it into the textarea.
- Results area:
  - Status line: `{count} rows{truncated ? " (truncated)" : ""} · {ms}ms`.
  - `Table` with column headers derived from `Object.keys(rows[0])`, values rendered with `String(v ?? "")`, max-height scroll container, sticky header.
  - "Copy as CSV" and "Download .csv" buttons (client-side CSV build with proper quoting).
  - Error state renders the agent error in a `bg-destructive/10` block.

No sidebar changes — `/bridge` is already linked. The existing jobs/agent panels stay as-is; SQL jobs will also show up in "Recent jobs" since they're regular `p21_bridge_jobs` rows.

## Out of scope
- Saved/named queries server-side (use catalog later via `runP21Query`).
- Writes — handler rejects anything but SELECT/WITH; UI just mirrors that.
- Pagination — rely on `TOP n` in the SQL and the 50k server cap.

## Files
- edit `src/lib/p21.functions.ts` — add `runP21Sql`.
- edit `src/routes/_app.bridge.tsx` — add SQL console card + CSV helpers.
