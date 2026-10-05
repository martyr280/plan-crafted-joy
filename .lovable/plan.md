# Warehouse manager (branch_manager) — read-only scoped access + admin invite readiness

Base: 46c2797 (verified locally). No publish. No real invites, auth users, role assignments or emails. No Sales Reports, Paycom, or dispatch-date SELECT changes.

## A. Schema (one new migration, add-only)
1. `ALTER TYPE app_role ADD VALUE 'branch_manager'` (separate migration step, committed before use).
2. Tables (GRANT to service_role only; RLS on; no client write policies):
   - `branch_manager_warehouses(user_id, warehouse CHECK IN ('Birmingham','Dallas','Ocala'), active, created_by, deactivated_at)`; partial unique index: one active row per user.
   - `branch_manager_invites(id, email_normalized, display_name, warehouse, status draft|cancelled|claimed|staged|sent|failed|revoked, user_id NULL, idempotency_key, attempt_count, last_error_code, timestamps)`; unique active row per normalized email.
   - Admin SELECT policy on both (via `has_role(admin)`); own-row SELECT on the mapping for the manager.
3. `private` schema helper `private.is_branch_manager(uuid)` — SECURITY DEFINER, `search_path=''`, EXECUTE revoked from PUBLIC/anon, granted only where policies need it.
4. RESTRICTIVE `branch_manager` deny policies on every public table for `authenticated`, except own `profiles`/`user_roles` read (auth bootstrap) and own mapping row. Composes with existing permissive policies so other users see no change.
5. Guard definer functions: `claim_admin_if_none` and `is_driver_time_viewer` return false/raise for branch managers; `has_role` unchanged; backfill grants unchanged. Storage: restrictive deny on `storage.objects` is NOT allowed (reserved schema) — instead verify no bucket policy grants branch access; report.
6. Invite state RPCs (SECURITY DEFINER, service_role-only EXECUTE): `bm_claim_invite`, `bm_stage_invite(invite, user_id, email)` (atomic role + mapping, rejects existing privileged/mixed users), `bm_mark_sent`, `bm_mark_failed`, `bm_revoke` (atomic deactivate mapping + delete only the branch_manager role row; never deletes the auth account).
7. Pre-apply: quote SQL, run in a rolled-back transaction, paste table/policy/grant counts. Then apply.

## B. Server (legacy gate + scoped read)
1. `src/lib/warehouse-scope.ts`, `branch-report.ts`, `branch-logistics.server.ts`, `branch-logistics.functions.ts` from the reference, reviewed: authoritative roles from `user_roles`, fail closed on lookup errors, empty route set returns empty with zero business reads.
2. `computeForecastForRoute(..., { logForecast: false })` option in `truck-capacity/serve.ts` + wrapper export; scoped path never logs/upserts.
3. Dispatch: read latest cached `dispatch-board` bridge result + timestamp/staleness only; no enqueue.
4. Add `denyLegacyBranchAccess` after `requireSupabaseAuth` on every server function in all 22 `*.functions.ts` (and Ask Nelson / MCP / public cron routes checked). Test enumerates all exports to prove coverage.

## C. Admin invite readiness (Settings > Users & Roles)
1. Draft save/cancel: admin-only server fns writing `branch_manager_invites` status `draft` only — no user id, role, mapping or email.
2. Separate "Invite branch manager" confirmation dialog showing role, warehouse and restrictions.
3. `inviteBranchManager` handler built on injected ports (auth / mail / db): claim → generateLink → verify returned user/email → stage via RPC → send → mark sent; failure → mark failed, retryable; token never returned or logged. In this task the real port wiring is present but the button stays disabled behind `app_settings.branch_invites_enabled` (absent = off), so nothing can execute.
4. Block branch_manager in the legacy password-user path and generic role toggles (server-side).

## D. UI
`/driver-time`, `/truck-capacity`, `/dispatch` render `BranchLogisticsPage` for branch managers; sidebar shows only those three; Ask Nelson bubble and global top-bar extras hidden; all other `_app` routes show "not available".

## E. Verification (synthetic only)
Unit tests: scope resolution, foreign route/run rejection, empty-set no-query, DTO redaction, legacy gate coverage, invite state machine with fake ports (idempotency, duplicate submit, concurrency, failure/retry, cancel-before-dispatch zero effects, revoke after failure, mismatched user, existing privileged account). Full suite, typecheck, lint, build. Read-only Playwright screenshots of Settings and the three routes as the existing admin (no new accounts). Evidence report: changed files, migration SQL + counts, test lines.

## Phases
1. A (migration, rollback-verified then applied) → 2. B → 3. C → 4. D → 5. E and report.

## Assumptions to correct
- Restrictive deny covers all 82 public tables (generated list at migration time).
- Invite button ships disabled via a settings flag until Marty enables it.
- Revocation removes only the branch_manager role row and deactivates the mapping.
