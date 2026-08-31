# Roadmap

## Open

- [ ] **Bridge agent TLS trust failure (NDI P21 server)** — v1.2.0 compiled agent
      fails every poll with `unable to verify the first certificate`. Working
      theory: FortiGate SSL deep inspection re-signs the Supabase TLS session with
      a corporate CA the compiled binary does not trust. Fix path: export chain to
      `corp-ca.pem`, set `NODE_EXTRA_CA_CERTS`; long-term ask NDI network admin for
      a `*.supabase.co` inspection bypass. Document in `agent/.env.example` +
      `agent/README.md` once confirmed.
- [ ] **52 stale pending `p21_bridge_jobs`** — queued since 2026-08-28. Decide
      expire-vs-run before the agent reconnects so three days of backlog does not
      fire at P21 at once.
- [ ] **Agent version reporting** — `p21_bridge_agents` still records `1.0.0`
      (last_seen 2026-08-28 14:19 UTC). Confirm it flips to `1.2.0` after the TLS
      fix; SFTP/CSV handlers for the Charlston export depend on v1.2.0 being live.
- [ ] `typical_dow` backfill for 33 of 35 truck-capacity routes (not yet run).
- [ ] Truck-capacity actuals are stale (max actual date 2026-07-29).

## Notes

- The 2026-08-28 08:00 UTC agent death was **platform-side**, not credentials:
  Cloudflare 520 + `SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED` 503s. Separate root
  cause from the current TLS failure.
