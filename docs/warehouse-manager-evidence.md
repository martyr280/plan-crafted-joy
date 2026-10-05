# Warehouse manager (branch_manager) — release evidence, 2026-10-05

Base: 46c2797. Not published. No real invites, auth users, role assignments or emails were created.

## Migrations (applied, in order)
- drizzle/migrations/0005_branch_manager_enum.sql — `ALTER TYPE app_role ADD VALUE 'branch_manager'` (own migration so the value is committed before use).
- 0006_branch_manager_scope_and_invites.sql — `private` schema; `private.is_branch_manager` (definer, search_path ''); tables `branch_manager_invites`, `branch_manager_warehouses`; write-guard triggers (writes only inside bm_* RPCs, no deletes); `user_roles` trigger (branch_manager exclusive, granted only via bm_stage); RESTRICTIVE `branch_manager_deny` on every public table (own profile/roles/mapping read kept); `claim_admin_if_none` refuses branch managers; RPCs bm_save_draft / bm_cancel / bm_claim / bm_stage / bm_mark_sent / bm_mark_failed, EXECUTE service_role only.
- 0007_branch_manager_guard_exec.sql — authenticated may evaluate the read-only guard helper (needed by the role trigger).
- 0008_branch_manager_revoke_client_writes.sql — revokes default grants: no client access to invites, SELECT-only on mapping.

## Post-apply checks (live)
tables 84 / RLS 84 / branch_manager_deny policies 84; invites 0, mappings 0, branch_manager roles 0;
authenticated: no EXECUTE on bm_* RPCs, no INSERT on mapping, no SELECT on invites.
Backfill grants unchanged (see gap: anon still has EXECUTE on backfill_sku_crossref_from_formerly — pre-existing, not widened, not changed).

## Tests
Full suite: Test Files 49 passed (49), Tests 486 passed (486). Typecheck (tsgo): exit 0. Preview build: "build OK".
Lint: new files only have the project-wide `no-explicit-any` pattern (baseline repo lint also fails).

New tests: branch-invite (synthetic ports: happy path, repeat, concurrency, cancel-before-dispatch, request mismatch,
unknown outcome reuses provider key, definite failure new key, existing privileged / pre-existing / mismatched account),
branch-logistics (adapter scope, fail-closed, foreign route/run, mixed roles, empty set no reads, no writes),
warehouse-scope, legacy-branch-gate (every createServerFn in 21 legacy modules), serve-readonly (promoted low-coverage
model: default writes activity + forecast log; logForecast:false writes nothing), BranchLogisticsPage render.
