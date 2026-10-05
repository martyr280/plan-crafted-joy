# Warehouse manager (branch_manager) — release evidence

Base: 46c2797. Not published. No real or synthetic remote auth users, emails, role assignments or invites
were created at any point. All invite behaviour is tested with in-memory fake ports only.

Raw outputs (ANSI stripped) live in `docs/evidence/warehouse-manager/`:
`tests-full.txt`, `typecheck.txt`, `lint-full.txt`, `lint-warehouse-files.txt`, `build-log.txt`,
`screenshots/{settings,driver-time,truck-capacity,dispatch}.png` (admin account, view-only).

## Migrations (applied, in order)
- 0005_branch_manager_enum — `app_role` gains `branch_manager` (separate so the value commits before use).
- 0006_branch_manager_scope_and_invites — private helpers, invite + mapping tables, write-guard triggers,
  exclusive-role trigger on `user_roles`, RESTRICTIVE `branch_manager_deny` on every public table,
  `claim_admin_if_none` refuses branch managers, bm_* RPCs (service_role only).
- 0007_branch_manager_guard_exec — authenticated may evaluate the read-only guard helper.
- 0008_branch_manager_revoke_client_writes — no client access to invites; SELECT-only on mapping.
- 0009_branch_manager_reconciliation — see below.
- 0010_branch_manager_role_serialization — per-user role locking and mixed-role denial in `has_role` (see below).

## 0010: role mutations serialized per user; mixed roles never honoured
- `private.bm_guard_user_roles` is now SECURITY DEFINER, so it sees every role row whatever the caller's
  RLS allows.
  - Before any check it takes `pg_advisory_xact_lock` keyed on the user. This applies to every insert and
    update on `user_roles`, for every role and every caller: the generic admin role toggles, invite staging,
    `claim_admin_if_none` and `handle_new_user`.
  - The lock is held until commit. Under READ COMMITTED each statement inside the trigger takes a new
    snapshot after the lock is acquired.
  - So of two concurrent transactions adding `branch_manager` and another role, the second waits, then sees
    the committed row and raises "cannot be combined". Mixed roles cannot commit.
  - Moving a row to a different `user_id` locks both users in a fixed order (no deadlock) and is refused for `branch_manager`.
- `bm_stage` takes the same lock before its existing-role check. If a privileged-role insert races an
  invite stage, one of two things happens:
  - The insert commits first: stage sees it and refuses with `existing_privileged_account`.
  - Stage commits first: the insert waits, then the trigger refuses it.
- `has_role(u, r)` returns false for any role other than `branch_manager` when `u` holds `branch_manager`.
  This covers all 95 `has_role` policies, including storage `pricer-pdfs ops read`, even if mixed rows were
  ever inserted manually around the triggers.
  - Non-branch users get the same results as before: the extra condition is true whenever they lack `branch_manager`.
  - Live mixed-role users: 0. Authenticated still has EXECUTE on `has_role`; the lock helper is not client-callable.
- How this was verified: live function definitions plus `branch-role-serialization.test.ts`, which pins the
  ordering in the migration. The two-session race was **not** run live: it needs two `auth.users` rows, and
  creating users is prohibited here. That evidence is Postgres lock semantics (confidence: high).

## 0009: unknown outcomes, crash recovery, default-role window
State machine: `draft -> claimed -> staged -> sending -> sent`, plus `failed`, `needs_reconciliation`,
`cancelled`, `revoked`.
- **Provider keys are never reused.** The action link is never stored, so a retry can't resend the same
  payload. Resend rejects the same key with a different body (409), so reusing keys was unreliable.
  Every claim now gets a fresh key.
- **`sending` is a durable marker** written right before the email call (`bm_begin_send`).
  - Before that point, every failure is `failed` and a plain retry is safe: no email can have gone out.
  - After it, only a definite provider rejection (4xx, including 429) is `failed`.
  - Anything else becomes `needs_reconciliation` with access off: a lost response, a 409, a 5xx, a timeout, or a failed write.
- **Worker crash or claim expiry.** A `sending` row whose claim has expired turns into
  `needs_reconciliation` on the next claim. The list also shows it that way. It is never resent silently.
- **`mark_sent` DB failure.** The provider's message id (a receipt, not a secret) is saved through
  `bm_mark_failed`. The admin then presses **Finish activation** (`bm_finish_activation`), which checks the
  role and mapping are consistent and switches access on without a second email.
- **No receipt.** A plain retry returns `needs_reconciliation` and does nothing. The admin must tick
  "recipient may receive two emails" before **Send fresh invite** can run. That uses a new key and a new link.
  **Revoke access** stays available.
- **Default-role window closed.** `handle_new_user` no longer gives `ops_orders` to an account whose email
  matches a live `claimed` invite. It records the id in `branch_manager_invites.created_user_id` instead.
  - `bm_stage` accepts only that bound account on the first attempt. This replaces the old created-at
    timestamp heuristic.
  - `bm_stage` rejects any account holding a role other than `branch_manager`.
  - So the invite account never holds operator capability, before or after staging, and a failed stage
    leaves it with no role.
  - Ordinary signups are unchanged.
  - **Side effect:** a self-signup with that email while an invite is mid-claim (a window of at most 10 minutes) gets no role
    until an admin assigns one. This fails closed.

## Live post-apply checks (2026-10-05)
public tables 84, RLS 84, `branch_manager_deny` 84; invites 0, mappings 0, branch_manager roles 0.
bm_begin_send/cancel/claim/finish_activation/mark_failed/mark_sent/save_draft/stage: authenticated=false,
service_role=true. handle_new_user contains the claimed-invite guard.

## Storage audit (live)
| bucket | public flag | read policy | branch manager |
|---|---|---|---|
| catalogs | public | `catalogs public read` (role public, any object in bucket) | same as an anonymous visitor: public catalog files only |
| pricer-images | public | `pricer-images public read` (role public) | same as an anonymous visitor: product images |
| pricer-pdfs | private | `pricer-pdfs ops read`: admin/ops_orders/ops_ar/sales_rep | **denied**: the serialized trigger stops mixed roles, and since 0010 `has_role` returns false for those roles even if a mixed row exists |
Writes in all three require admin. The storage schema is reserved, so no restrictive policy was added there.
A branch manager gains nothing beyond what the public internet already has. If catalogs or images
should stop being public, that is a separate decision for everyone, not just warehouse managers.

## Tests / typecheck / lint / build (re-run after all corrections, 2026-10-05)
Run inside the Lovable sandbox (Linux, bun). Raw logs are in `docs/evidence/warehouse-manager/`.
- **Tests** (`bunx vitest run`, `tests-full.txt`): `Test Files 50 passed (50)`, `Tests 500 passed (500)`, exit 0.
- **Typecheck** (`tsgo --noEmit`, `typecheck.txt`): exit 0, no diagnostics.
- **Build** (`bun run build` = `vite build`, `build-full.txt`): exit 0, built in 29.74s (58.7s wall).
  Only the standard notices: `"use client"` directives ignored in node_modules, chunk size, and nitro
  `platform` input option. `build-log.txt` is the preview's automatic build log, kept separately.
- **Lint, new warehouse files** (`lint-warehouse-files.txt`): exit 0, zero errors or warnings, no rule
  disabled. The 67 `any`s were replaced with real types.
  - New types: `CapacityRunRow`, `DispatchRunRow`, `DispatchStopRow`, `TicketRow`, `ForecastDto`,
    `DriverEventRow`, `OverrideRow`, `ReconciledDriver`, `BranchReport`. `BranchReport` is a discriminated
    union on `module`.
  - The invite RPC reply is now zod-validated, so an unexpected shape fails closed.
  - The invites list now checks the warehouse value and fails closed on an unknown one.
  - `currentMonday` moved to `src/lib/branch-week.ts`, which fixes the fast-refresh warning.
  - Typing surfaced one real bug, now fixed: a driver event with no duration would have passed null to
    `formatMinutes`. It now shows "Unknown".
- **Lint, repository baseline** (`eslint .`, `lint-full.txt`): exit 1, 11,305 problems (11,257 errors,
  48 warnings), almost all in code that predates this feature.
  - Of the existing files this feature edited, 4 gained findings, all `prettier/prettier` formatting on the
    edited lines:
    - AppSidebar.tsx: 20→21
    - serve.ts: 50→58
    - user-admin.functions.ts: 37→43
    - _app.settings.tsx: 70→71
  - No new rule-level findings. Reformatting those whole files was left out to keep the diff reviewable.
  - The other 24 edited existing files gained nothing.

## Settings screenshots (view-only, as admin; no invite submitted)
`screenshots/settings-draft-form.png`, `settings-draft-saved.png`, `settings-invite-confirmation.png`,
`settings-draft-cancelled.png`, plus `settings.png`, `driver-time.png`, `truck-capacity.png`, `dispatch.png`.
- **Rows created:** two synthetic drafts, `qa-screenshot-draft@example.com` and
  `qa-screenshot-draft-2@example.com`. The first was a framing retake.
- **No invite was submitted.** The confirmation dialog was opened and closed with Cancel, and 0 server calls
  were made while it was open.
- **Both drafts were then cancelled.**
- **Live readback:** both rows are `cancelled`, `attempt_count` 0, no `user_id`, `created_user_id`,
  `resend_key` or provider id. 0 mappings, 0 branch_manager roles, 0 profiles for those emails, no email.

## Unchanged by design
Sales Reports rules (`sales-annualized-template.ts`, `sales-reports.server.ts`), dispatch date basis and
SELECT (`dispatch/assign.ts`, `dispatch/build.ts`) and Paycom handling are not in the diff. In the 22 legacy
`*.functions.ts` files the only changed lines are the middleware swap.

## Changed files
`docs/evidence/warehouse-manager/changed-files.txt` (`git diff --name-status 46c2797`).
Repository HEAD when this evidence was captured: `c8b27de`. The platform commits this turn's edits
automatically afterwards.

## Known residuals
- `anon` can EXECUTE `backfill_sku_crossref_from_formerly`. This predates the feature and was left untouched as instructed.
- New tables have no `tenant_id`. The project has no tenant model: `profiles.tenant_id` does not exist.
- No end-to-end run as a real warehouse manager. That would need a real account, which is prohibited before release.

## Correction 0011 — pending invite identities fail closed (2026-10-05)
- `private.is_branch_manager` now returns true for any account bound by `branch_manager_invites.user_id` or `created_user_id` (any status, incl. failed/cancelled/revoked), not only branch_manager role rows. Restrictive deny policies, `has_role` (incl. private PDF storage), `claim_admin_if_none` and the role guard trigger all inherit this.
- Role guard: no role can be added to a bound identity (zero-role pending accounts can't be "rescued" into operators).
- Legacy gate: `checkLegacyAccessWith(roles, userId, binding)` denies when the self-only RPC `current_user_is_branch_bound()` (authenticated only, anon revoked; no session = bound) is not exactly `false`; any error fails closed. `assertNotBranchUser` checks invite binding too.
- Synthetic tests: pending (pre-stage), stage-failed, revoked, needs_reconciliation zero-role fixtures denied by legacy gate and branch report; lookup failure fails closed; unbound users unchanged.
- Evidence: vitest 51 files / 506 tests pass; `tsgo --noEmit` exit 0; lint on touched warehouse files exit 0; `bun run build` exit 0 (`build-0011.log`). Live readback: 0 bound invites, 0 branch roles, 0 mappings; anon cannot execute probe.
- Trade-off: a revoked invite-created account stays permanently branch-bound; reusing that person as an operator needs a new account.

## Correction 0012 — anon execute on backfill definer (2026-10-05)
- Before: `backfill_sku_crossref_from_formerly()` ACL `{postgres, anon, service_role}` (anon=true, authenticated=false).
- Migration `0012_revoke_anon_backfill_sku_crossref.sql`: REVOKE from PUBLIC, anon, authenticated; GRANT service_role. Function body unchanged; no app/agent code calls it.
- Live after: anon=false, authenticated=false, service_role=true. No public SECURITY DEFINER function is anon-executable (full 16-function matrix in `src/lib/__tests__/definer-grant-inventory.test.ts`).
- Evidence: vitest 52 files / 509 tests pass; `tsgo --noEmit` exit 0; lint on new test exit 0.

## Independent native SQL verification (reported by m_reed, 2026-10-05)
- Scope: migrations 0005–0010 as captured at commit b3fb5f2, run in a disposable local native PostgreSQL 17.6 cluster (matches live server_version), synthetic SQL `auth.users` fixtures only. Not PGlite.
- Result: 20 checks passed. Two independent pg8000 connections raced branch_manager-first and ops_orders-first role inserts; in both directions the loser blocked on the advisory lock (pg_stat_activity), and after the winner committed the loser rejected the mixed role; only the winner's role remained.
- Also passed: RLS SELECT/INSERT/UPDATE/DELETE, profile/role restrictions, no operator role at signup for claimed invites, inactive staging, invite-RPC and admin-bootstrap denial, no resend on unknown outcome.
- Artifacts: `native-results.json` / `verify_native.py` in the reviewer's workspace (not in this repo).
- Limits: this is native SQL verification only, NOT Supabase Auth/REST parity. Migrations 0011 (pending-identity deny) and 0012 (anon backfill revoke) were not covered; reviewer will rerun them before release.

## Release-candidate checks after 0011 + 0012 (2026-10-05)
- `bun run build` exit 0 (`build-0012.log`); vitest 52 files / 509 tests pass; `tsgo --noEmit` exit 0; eslint on all touched warehouse files exit 0.
- Nothing published; no real auth users, roles, mappings, invites or email.
