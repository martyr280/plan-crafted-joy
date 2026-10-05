// Static guard on migration 0013 + presence of the native-SQL window tests.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../../..");
const sql = readFileSync(
  join(root, "drizzle/migrations/0013_branch_manager_signup_reservation.sql"),
  "utf8",
);
const native = readFileSync(join(root, "tests/native/0013_signup_reservation.sql"), "utf8");
const fn = sql.slice(sql.indexOf("FUNCTION public.handle_new_user"));

describe("signup reservation (migration 0013)", () => {
  it("reservation ignores lease expiry and status except never-claimed cancelled drafts", () => {
    expect(fn).not.toMatch(/claim_expires_at/);
    expect(fn).not.toMatch(/status = 'claimed'/);
    expect(fn).toMatch(/NOT \(status = 'cancelled' AND first_claimed_at IS NULL\)/);
  });
  it("binds created_user_id and returns before the operator default", () => {
    const bind = fn.indexOf("SET created_user_id = NEW.id");
    const ret = fn.indexOf("RETURN NEW", bind);
    const ops = fn.indexOf("'ops_orders'");
    expect(bind).toBeGreaterThan(0);
    expect(ret).toBeGreaterThan(bind);
    expect(ops).toBeGreaterThan(ret);
  });
  it("rejects creation when every reserving row is already bound", () => {
    expect(fn).toMatch(/IF v_invite IS NULL THEN\s+RAISE EXCEPTION/);
  });
  it("native-SQL tests cover expired, cancelled-after-claim, revoked, draft, zero-effect cancel, rebind", () => {
    for (const s of [
      "expired@",
      "cancelclaimed@",
      "revoked@",
      "draftonly@",
      "cancelleddraft@",
      "PASS rebind rejected",
      "ROLLBACK;",
    ])
      expect(native).toContain(s);
  });
});
