# NDI P21 Bridge Agent

This is a small Node program that runs **on a machine inside your network with the FortiClient VPN connected**. It dials out to NDI Ops Hub, picks up P21 jobs from a queue, runs the SQL through your VPN, and posts results back. No inbound firewall rule, no VPN exposure to the cloud.

## What it does

- Heartbeats to the app every 5 seconds so you can see "agent online" in Settings → Integrations.
- Pulls pending jobs from `/api/public/p21-bridge`, signs every request with HMAC-SHA256.
- Runs only the job kinds defined in `handlers/index.js` (allowlist — the app cannot ask for arbitrary SQL).
- Returns JSON results (or an error message) to the app.

## One-time setup

1. Install **Node.js 20 LTS** on the machine: <https://nodejs.org/>
2. Make sure **FortiClient is connected** and you can reach the P21 SQL Server (try `telnet p21sql.internal 1433`).
3. Copy this `agent/` folder to the machine (anywhere, e.g. `C:\ndi-agent\`).
4. From a terminal in that folder:

   ```bash
   npm install
   cp .env.example .env   # on Windows: copy .env.example .env
   ```

5. Edit `.env`:
   - `BRIDGE_URL` — already filled in for your project.
   - `BRIDGE_SECRET` — copy from **NDI Ops Hub → Settings → Integrations → P21 Bridge → Show secret**.
   - `P21_SQL_*` — your read-only SQL credentials and host.
   - `AGENT_NAME` — anything friendly, e.g. `office-server-01`.

6. Test it interactively:

   ```bash
   npm start
   ```

   You should see "Polling…" output, and in the app the agent shows up as **online (green)**. From the Integrations page click **Run ping** to round-trip a query.

## Run as a Windows service (so it survives reboots)

```bash
npm run install-service
```

This registers it as **"NDI P21 Bridge Agent"** under Windows Services. To remove:

```bash
npm run uninstall-service
```

## Adding new job kinds

1. Drop a new file in `handlers/`, exporting an `async function (payload) { ... }`.
2. Register it in `handlers/index.js`.
3. From the app, call `enqueueP21Job({ kind: "your.kind", payload: {...} })`.

The kind name is a string — `sales.query`, `ar.aging`, etc. Use parameterized SQL via `query("... WHERE x = @id", { id })` — never string-concatenate.

## Troubleshooting

- **"bridge claim failed: 401 bad signature"** — `BRIDGE_SECRET` in `.env` doesn't match the secret in Lovable Cloud. Re-copy it.
- **"bridge claim failed: 401 stale signature"** — the machine's clock is off by more than 5 minutes. Sync time.
- **"Login failed for user…"** — check `P21_SQL_USER` / `P21_SQL_PASS`. Make sure FortiClient is connected.
- **"connect ETIMEDOUT"** — VPN is not connected or `P21_SQL_HOST` is unreachable.
- **App says "Bridge job timed out"** — agent isn't running, or the secret is wrong, or the job kind isn't in the handler allowlist.
