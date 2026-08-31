# Roadmap

## Open

- [ ] **Bridge agent TLS trust failure (NDI P21 server)** — v1.2.0 compiled agent
      fails every poll with `unable to verify the first certificate`. Working
      theory: FortiGate SSL deep inspection re-signs the Supabase TLS session with
      a corporate CA the compiled binary does not trust. Fix path: export chain to
      `corp-ca.pem`, set `NODE_EXTRA_CA_CERTS`; long-term ask NDI network admin for
      a `*.supabase.co` inspection bypass. Document in `agent/.env.example` +
      `agent/README.md` once confirmed.
- [x] **Expired 52 stale pending `p21_bridge_jobs` before agent reconnects** — retained
      the fresh 2026-08-31 14:59 UTC job so the first claim tests current work only.
- [ ] **Agent version reporting** — `p21_bridge_agents` still records `1.0.0`
      (last_seen 2026-08-28 14:19 UTC). Confirm it flips to `1.2.0` after the TLS
      fix; SFTP/CSV handlers for the Charlston export depend on v1.2.0 being live.
- [ ] **Determine what changed on the agent host on 2026-08-28** — last successful
      heartbeat reported version `1.0.0`; the v1.2.0 Bun-compiled exe has *never*
      heartbeated once. Suspect the launch method changed (node-windows service
      running `node agent.js` → bare `ndiOS-agent.exe` process), not a firewall
      change. Test: run `node agent.js` on the host with the same `.env`.
- [ ] `typical_dow` backfill for 33 of 35 truck-capacity routes (not yet run).
- [ ] Truck-capacity actuals are stale (max actual date 2026-07-29).

## Notes

- The 2026-08-28 08:00 UTC agent death was **platform-side**, not credentials:
  Cloudflare 520 + `SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED` 503s. Separate root
  cause from the current TLS failure.

## SFTP export test (2026-08-31)

- [x] Dry-run `website.export.sftp` verified: 5,142 rows / 832 KB / 5 columns.
- [ ] Live SFTP delivery test to `files.ndiofficefurniture.net/Charlston_OF`.
- [ ] Let admins download the generated CSV from the Website Export page to verify contents
      (currently only a 3-line preview is stored).
