import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const supabaseSql = readFileSync(
  "supabase/migrations/20261110120000_driver_pay_logistics_admin.sql",
  "utf8",
);
const drizzleSql = readFileSync("drizzle/migrations/0021_driver_pay_logistics_admin.sql", "utf8");

function live(sql: string) {
  return sql.split("/*")[0] ?? sql;
}

describe("driver pay migration", () => {
  for (const [name, sql] of [
    ["supabase", supabaseSql],
    ["drizzle", drizzleSql],
  ] as const) {
    it(`${name} copy is reversible, scoped, and does not grant anon or delete`, () => {
      const up = live(sql);
      expect(up).toMatch(/SET search_path = ''/);
      expect(up).toMatch(/SECURITY INVOKER/);
      expect(up).toMatch(/public\.has_role\(_user_id, 'admin'::public\.app_role\)/);
      expect(up).toMatch(/public\.has_role\(_user_id, 'ops_logistics_admin'::public\.app_role\)/);
      expect(up).toMatch(
        /REVOKE ALL ON FUNCTION public\.can_manage_driver_pay\(uuid\) FROM PUBLIC, anon, authenticated/,
      );
      expect(up).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.can_manage_driver_pay\(uuid\) TO authenticated, service_role/,
      );
      expect(up).not.toMatch(
        /GRANT EXECUTE ON FUNCTION public\.can_manage_driver_pay\(uuid\) TO[^;]*\banon\b/,
      );
      expect(up).not.toMatch(/FOR DELETE/);
      expect(up).not.toMatch(/DROP POLICY[^;]*branch_manager_deny/i);
      expect(up).not.toMatch(/DROP POLICY[^;]*Admins manage driver pay rates/);
      expect(up).not.toMatch(/INSERT INTO public\.user_roles/i);
      expect(up).not.toMatch(/INSERT INTO public\.driver_pay_rates/i);
      expect(sql).toMatch(/Undo \(do not run as part of this migration\)/);
      expect(sql).toMatch(/DROP POLICY IF EXISTS "Logistics admins read driver pay rates"/);
      expect(sql).toMatch(/DROP POLICY IF EXISTS "Logistics admins insert driver pay rates"/);
      expect(sql).toMatch(/DROP POLICY IF EXISTS "Logistics admins update driver pay rates"/);
      expect(sql).toMatch(
        /REVOKE ALL ON FUNCTION public\.can_manage_driver_pay\(uuid\) FROM PUBLIC, anon, authenticated, service_role/,
      );
      expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.can_manage_driver_pay\(uuid\)/);
      const undo = sql.slice(sql.indexOf("Undo"));
      expect(undo).toMatch(/branch_manager_deny/);
      expect(undo).not.toMatch(/GRANT .*ops_logistics_admin/);
    });
  }
});
