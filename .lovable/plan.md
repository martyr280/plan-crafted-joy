## P21 Bridge via Local Agent (Version A)

A small Node agent runs on your Windows machine (the one with FortiClient). It dials **out** to this app over HTTPS, polls a job queue, runs SQL against P21 through the VPN, and posts results back. No inbound firewall rule, no VPN exposure to the cloud.

```text
 Browser (you)         Lovable Cloud (Worker)            Your machine + FortiClient
 ───────────         ─────────────────────────           ─────────────────────────
   UI ──────────► /api/public/p21-bridge  ◄─────── poll ── agent.js
                  (HMAC-signed job queue)  ─────── result─►  └─► P21 SQL Server
```

### What gets built

**1. Database (`p21_bridge_jobs` table)**
- `id`, `kind` (e.g. `sales_query`, `ar_aging`, `submit_order`), `payload` jsonb, `status` (`pending`/`claimed`/`done`/`error`), `result` jsonb, `error`, `created_at`, `claimed_at`, `completed_at`, `agent_id`.
- `p21_bridge_agents` table: `id`, `name`, `last_seen_at`, `version`, `ip`. Heartbeats from the agent.
- RLS: admins read/write all; service role used by the bridge endpoint.

**2. Server route `src/routes/api/public/p21-bridge.ts`**
- `POST /api/public/p21-bridge/claim` — agent claims up to N pending jobs. HMAC-signed with `P21_BRIDGE_SECRET`.
- `POST /api/public/p21-bridge/complete` — agent posts `{ jobId, result | error }`.
- `POST /api/public/p21-bridge/heartbeat` — updates `last_seen_at`.
- All requests verified with `x-bridge-signature` header (HMAC-SHA256 of body + timestamp).

**3. Server functions `src/server/p21.functions.ts`**
- `enqueueP21Job({ kind, payload })` — admin-protected; inserts a job, polls for completion (with timeout), returns result.
- Replaces the `// TODO: replace with P21 SQL` stubs in sales/AR/orders flows so admins can flip individual modules from "stub" to "live bridge" via Settings.

**4. Settings → Integrations panel update**
- Status card for the P21 Bridge: agent name, last seen (green if <60s, yellow <5m, red otherwise), pending/failed job counts.
- Per-module toggle: "Use live P21 via bridge" vs "Use stubbed seed data" (stored in a small `integration_settings` table).
- "Rotate bridge secret" button + copy-to-clipboard for the agent config.

**5. `agent/` folder (committed in repo, runs on your machine)**
- `agent/package.json` — minimal Node 20 deps: `mssql` (P21 is SQL Server), `node-fetch` not needed (Node 20 has fetch), `dotenv`.
- `agent/agent.js` — loop: heartbeat → claim jobs → run handler per `kind` → post result. 5s poll interval.
- `agent/handlers/` — one file per job kind, each is a parameterized SQL query against P21.
- `agent/.env.example` — `BRIDGE_URL`, `BRIDGE_SECRET`, `P21_SQL_HOST`, `P21_SQL_DB`, `P21_SQL_USER`, `P21_SQL_PASS`, `AGENT_NAME`.
- `agent/README.md` — install steps:
  1. Install Node 20 LTS.
  2. `cd agent && npm install`.
  3. Copy `.env.example` → `.env`, fill in P21 creds + bridge secret (copied from Settings).
  4. Make sure FortiClient is connected.
  5. `node agent.js` to test, then install as a Windows service with `node-windows` (script included) so it runs on boot.

**6. Secret**
- `P21_BRIDGE_SECRET` — generated and stored as a Lovable Cloud secret. The same value goes in `agent/.env`.

### Security properties
- Outbound-only from your network; FortiGate sees normal HTTPS to `*.lovable.app`.
- HMAC signature on every request → only an agent holding the secret can claim/complete jobs.
- Timestamp in signed payload → 5-minute replay window.
- Service-role writes happen only after signature verification.
- Per-job type allowlist on the agent → app cannot ask the agent to run arbitrary SQL.

### What I will NOT build (out of scope for now)
- Auto-installer / MSI for the agent (manual `npm install` + service step is fine for one machine).
- Multi-agent failover (single agent is enough; schema supports more later).
- Live P21 query editor in the UI (job kinds are predefined for safety).

### After approval
I'll create the migration, the bridge route, the server functions, the Settings panel, the `agent/` folder, and request the `P21_BRIDGE_SECRET` secret. Then you copy the secret + your P21 creds into `agent/.env`, run `node agent.js`, and the bridge goes live.

---

## Section H — Inbound Email Pipeline Fix

**H.1 — Root cause**
Resend does not support inbound email parsing. The current webhook is receiving outbound delivery events with no email content. `inbound_emails` table has 0 rows.

**H.2 — Inbound provider**
Use Postmark Inbound as the inbound email parser. It delivers a clean JSON webhook with From, Subject, TextBody, HtmlBody, Attachments, and Headers parsed out of the box.

**H.3 — Build receive-inbound-email edge function**
Create a Supabase edge function `receive-inbound-email` that accepts POST from Postmark, verifies via `POSTMARK_INBOUND_SECRET`, maps Postmark fields to our schema, inserts into `inbound_emails`, calls `classify-inbound-email`, and routes to downstream records (orders, ar_reply activity, damage_reports, fleet_loads) when confidence >= 0.75.

**H.4 — Remove Resend inbound webhook**
Remove/disable the Resend inbound webhook handler. Keep Resend for outbound sending only.

**H.5 — Add webhook URL to admin UI**
On the webhook debug page, show the Postmark inbound webhook URL `{SUPABASE_URL}/functions/v1/receive-inbound-email` and the `POSTMARK_INBOUND_SECRET` env var name.

**H.6 — Execution order**
1. Write plan ← done
2. Build edge function (H.3)
3. Wire auto-routing (H.3)
4. Update webhook debug page (H.5)
5. Remove Resend inbound (H.4)
