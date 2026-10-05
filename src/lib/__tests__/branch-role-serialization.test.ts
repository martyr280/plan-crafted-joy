// Static guard on migration 0010: role mutations are serialized per user and has_role never
// grants another role to a branch manager. The live race is proven by Postgres lock semantics
// (advisory xact lock held to commit + fresh READ COMMITTED snapshot per trigger statement);
// this test stops a later migration from silently dropping either piece.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../drizzle/migrations/0010_branch_manager_role_serialization.sql"),
  "utf8",
);

describe("branch-manager role serialization (migration 0010)", () => {
  it("trigger takes a per-user advisory lock before the mixed-role check, for every role", () => {
    const guard = sql.slice(sql.indexOf("FUNCTION private.bm_guard_user_roles"));
    const lockAt = guard.indexOf("bm_lock_user_roles(NEW.user_id)");
    const checkAt = guard.indexOf("cannot be combined with other roles");
    expect(lockAt).toBeGreaterThan(0);
    expect(lockAt).toBeLessThan(checkAt);
    expect(guard.slice(0, 400)).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('nelson\.user_roles:'/);
  });
  it("user_id moves lock both users in fixed order and cannot move branch_manager", () => {
    expect(sql).toMatch(
      /least\(OLD\.user_id, NEW\.user_id\)[\s\S]*greatest\(OLD\.user_id, NEW\.user_id\)/,
    );
    expect(sql).toMatch(/cannot be moved between users/);
  });
  it("bm_stage locks the user before checking existing roles", () => {
    const stage = sql.slice(sql.indexOf("FUNCTION public.bm_stage"));
    expect(stage.indexOf("bm_lock_user_roles(p_user_id)")).toBeLessThan(
      stage.indexOf("existing_privileged_account"),
    );
  });
  it("has_role denies non-branch roles to any user holding branch_manager", () => {
    const hr = sql.slice(sql.indexOf("FUNCTION public.has_role"));
    expect(hr).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.user_roles WHERE user_id = _user_id AND role = 'branch_manager'/,
    );
  });
  it("lock helper is not callable by clients", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION private\.bm_lock_user_roles\(uuid\) FROM PUBLIC, anon, authenticated/,
    );
  });
});
