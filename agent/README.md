# NDI P21 Bridge Agent

This is a small Node program that runs **on a machine inside your network with the FortiClient VPN connected**. It dials out to NDI Ops Hub, picks up P21 jobs from a queue, runs the SQL through your VPN, and posts results back. No inbound firewall rule, no VPN exposure to the cloud.

## What it does

- Heartbeats to the app every 5 seconds so you can see "agent online" in Settings → Integrations.
- Pulls pending jobs from `/api/public/p21-bridge`, signs every request with HMAC-SHA256.
- Runs only the job kinds defined in `handlers/index.js` (allowlist — the app cannot ask for arbitrary SQL).
- Returns JSON results (or an error message) to the app.

## Quick install — prebuilt `.exe` (no Node, no installer)

The agent ships as a single self-contained Windows executable (~112 MB) with the runtime and all dependencies bundled inside. **Use this path if you don't want to install Node.js or register a Windows service.**

1. **Get `ndiOS-agent.exe`** — either:

   - **Download it from GitHub Releases**: every time a tag matching `agent-v*` is pushed (e.g. `agent-v1.0.0`), CI builds the .exe and attaches it (with a `.sha256` checksum) to a release at <https://github.com/martyr280/plan-crafted-joy/releases>. To cut a new release: `git tag agent-v1.0.0 && git push origin agent-v1.0.0`.

   - **Or build it yourself** on any machine that has [Bun](https://bun.sh) installed:

     ```bash
     cd agent
     bun install
     bun run build:exe   # writes dist/ndiOS-agent.exe
     ```

2. On the P21 server, create `C:\ndiOS-agent\` and drop two files into it:
   - `ndiOS-agent.exe` (from step 1)
   - `.env` — copy the contents of [`.env.example`](.env.example) and fill in the values (bridge secret, P21 API consumer key + service account, SQL creds if you want SQL jobs)

3. **Run it from PowerShell** to smoke-test:

   ```powershell
   cd C:\ndiOS-agent
   .\ndiOS-agent.exe
   ```

   You should see `Polling https://plan-crafted-joy.lovable.app/...` and the agent will show **online (green)** in the app within 5 seconds. `Ctrl+C` to stop.

4. **Make it survive reboots via Task Scheduler** (no admin install, no service registration). From PowerShell:

   ```powershell
   $action  = New-ScheduledTaskAction -Execute "C:\ndiOS-agent\ndiOS-agent.exe" -WorkingDirectory "C:\ndiOS-agent"
   $trigger = New-ScheduledTaskTrigger -AtStartup
   $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
   $settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
   Register-ScheduledTask -TaskName "ndiOS Agent" -Action $action -Trigger $trigger -Principal $principal -Settings $settings
   Start-ScheduledTask -TaskName "ndiOS Agent"
   ```

   That registers a task that runs as `SYSTEM` at boot, restarts every minute on failure, and starts now. To uninstall: `Unregister-ScheduledTask -TaskName "ndiOS Agent" -Confirm:$false`.

5. **View logs**: the `.exe` writes to stdout. To capture them to disk, change step 4's `-Execute` to a small wrapper or, simplest, run from PowerShell with redirection:

   ```powershell
   .\ndiOS-agent.exe *>> .\ndiOS-agent.log
   ```

That's it — no Node, no npm, no `node_modules`, no service registration, no admin rights for the install itself (though writing to `C:\ndiOS-agent\` may need admin once at folder-creation time).

---

## Full setup (from source, with Node + Windows service)

Use this path if you want to develop on the agent, or prefer a managed Windows service over Task Scheduler.

1. Install **Node.js 20 LTS** on the machine: <https://nodejs.org/>
2. Make sure **FortiClient is connected** and you can reach the P21 SQL Server (try `telnet p21sql.internal 1433`).
3. Copy this `agent/` folder to the machine (anywhere, e.g. `C:\ndiOS-agent\`).
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

> **Run an Administrator command prompt for these commands** — Windows requires elevation to install services.

1. Right-click **Command Prompt** (or **PowerShell**) → **Run as administrator**.
2. `cd` into the `agent` folder.
3. Install:

   ```bash
   npm run install-service
   ```

   This registers a service named **"NDI P21 Bridge Agent"** with these properties:
   - **Startup type:** Automatic (starts on boot, before any user logs in)
   - **Recovery:** auto-restart on crash (up to 10 retries with backoff)
   - **Working directory:** the `agent/` folder, so `.env` and SQL config load correctly
   - **Logs:** `agent/daemon/ndi-p21-bridge-agent.out.log` and `.err.log`

4. Verify it's running:

   ```bash
   sc query "NDI P21 Bridge Agent"
   ```

   Or open **services.msc** and look for "NDI P21 Bridge Agent".

5. The agent should appear as **online (green)** in **NDI Ops Hub → Settings → Integrations → P21 Bridge** within 5 seconds.

### Updating or removing the service

Stop and remove (also from an Administrator prompt):

```bash
npm run uninstall-service
```

After editing `.env` or pulling new agent code, restart the service:

```bash
sc stop "NDI P21 Bridge Agent"
sc start "NDI P21 Bridge Agent"
```

### Notes about the FortiClient VPN

The Windows service runs as **LocalSystem** by default, which starts before any user logs in. This means:

- ✅ If FortiClient is configured to **auto-connect at system startup** (recommended), the agent will reach P21 right away.
- ⚠️ If FortiClient only connects after a **user logs in interactively**, the agent will sit there retrying until you log in and FortiClient comes up. Configure FortiClient → Settings → "Always Up" / "Auto Connect" to avoid this.

## P21 Data API (REST)

The agent can also call P21's REST API alongside direct SQL. The agent should run **on the P21 server itself** so the base URL stays on loopback and the consumer key never leaves the box.

1. In the **P21 Middleware Configuration Utility**, register a consumer and copy the generated **consumer key**.
2. Pick a P21 service account (separate from your SQL read-only login) and note its username/password.
3. Fill in the `P21_API_*` block in `.env`:
   - `P21_API_BASE_URL` — IIS path to the P21 API service (e.g. `http://localhost/P21APIService`).
   - `P21_API_CONSUMER_KEY` — from step 1.
   - `P21_API_CONSUMER_KEY_HEADER` — leave as `Authorization` unless your install uses a custom header.
   - `P21_API_USERNAME` / `P21_API_PASSWORD` — from step 2.
4. Restart the agent (`sc stop ... && sc start ...` for the service).
5. From the app, call `testP21ApiConnection()` — it round-trips `POST /api/security/token` and returns the token prefix on success.
6. To read data, call `queryP21View({ view: "P21Customers", query: { "$top": 50, "$filter": "..." } })`. The handler hits `GET /data/erp/views/v1/<view>` and returns `{ rows, count }`.

The access token is cached in the agent process for ~50 minutes and refreshed automatically on a 401.

## E2G Combined Report (`e2g.combined-report`)

A pre-canned inventory report that joins regular products, kit products, and open POs across the Birmingham (`21`), Dallas (`41`), and Ocala (`51`) locations. SQL lives in `agent/handlers/e2g-report.js`.

End-to-end flow:

1. Agent must have valid `P21_SQL_*` env vars (this is a SQL handler, not REST).
2. A scheduled trigger calls `POST /api/public/sync-e2g` on the web app with `Authorization: Bearer <CRON_SECRET>`.
3. The server enqueues an `e2g.combined-report` job; the agent runs the SQL.
4. The server replaces the `public.e2g_inventory_snapshot` Supabase table with the new rows.

To wire up the schedule, set two values:

- **Lovable Cloud secret** → `CRON_SECRET=<random 32+ char string>` so the webhook can authenticate the caller.
- **GitHub Actions secret** → `CRON_SECRET=<same value>` at <https://github.com/martyr280/plan-crafted-joy/settings/secrets/actions>. The workflow at `.github/workflows/sync-e2g.yml` runs nightly at 06:00 UTC and hits the webhook.

Manual sync (admin only) is also available via the `syncE2GReport` server function — wire it to a button in Settings if you want one-click resyncs.

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
