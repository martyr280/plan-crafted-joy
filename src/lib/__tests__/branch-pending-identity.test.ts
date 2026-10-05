// Static guard on migration 0011: invite-created identities are branch-bound before any role row.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../drizzle/migrations/0011_branch_manager_pending_identity_deny.sql"),
  "utf8",
);

describe("pending invite identities fail closed (migration 0011)", () => {
  it("is_branch_manager includes invite user_id and created_user_id bindings, any status", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION private.is_branch_manager"));
    expect(fn).toMatch(/branch_manager_invites WHERE user_id = _user_id OR created_user_id = _user_id/);
    expect(fn.slice(0, fn.indexOf("$$;"))).not.toMatch(/status/);
  });
  it("has_role denies non-branch roles to bound identities", () => {
    expect(sql).toMatch(/OR NOT private\.is_branch_manager\(_user_id\)/);
  });
  it("role guard blocks adding any role to a bound identity", () => {
    expect(sql).toMatch(/ELSIF private\.is_branch_manager\(NEW\.user_id\) THEN/);
  });
  it("self probe is not callable by anon and treats no session as bound", () => {
    expect(sql).toMatch(/auth\.uid\(\) IS NULL OR private\.is_branch_manager\(auth\.uid\(\)\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.current_user_is_branch_bound\(\) FROM PUBLIC, anon/);
  });
});
