// Callable SECURITY DEFINER grant inventory (public schema). Live matrix verified 2026-10-05:
// no definer function is executable by anon; mutation/bridge RPCs are service_role only.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../drizzle/migrations");
const all = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");
const m12 = readFileSync(join(dir, "0012_revoke_anon_backfill_sku_crossref.sql"), "utf8");

export const EXPECTED: Record<string, { anon: false; authenticated: boolean }> = {
  backfill_sku_crossref_from_formerly: { anon: false, authenticated: false },
  bm_begin_send: { anon: false, authenticated: false },
  bm_cancel: { anon: false, authenticated: false },
  bm_claim: { anon: false, authenticated: false },
  bm_finish_activation: { anon: false, authenticated: false },
  bm_mark_failed: { anon: false, authenticated: false },
  bm_mark_sent: { anon: false, authenticated: false },
  bm_save_draft: { anon: false, authenticated: false },
  bm_stage: { anon: false, authenticated: false },
  handle_new_user: { anon: false, authenticated: false },
  claim_admin_if_none: { anon: false, authenticated: true },
  current_sales_rep_code: { anon: false, authenticated: true },
  current_user_is_branch_bound: { anon: false, authenticated: true },
  has_role: { anon: false, authenticated: true },
  is_capacity_alert_manager: { anon: false, authenticated: true },
  is_driver_time_viewer: { anon: false, authenticated: true },
};

describe("definer grant inventory", () => {
  it("0012 revokes backfill from PUBLIC/anon/authenticated and keeps only service_role", () => {
    expect(m12).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.backfill_sku_crossref_from_formerly\(\) FROM PUBLIC, anon, authenticated/,
    );
    expect(m12).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.backfill_sku_crossref_from_formerly\(\) TO service_role;/,
    );
    expect(m12).not.toMatch(/TO (anon|authenticated|PUBLIC)/i);
  });
  it("no warehouse migration ever grants a definer function to anon", () => {
    expect(all).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*TO[^;]*\banon\b/i);
  });
  it("no definer function is anon-callable in the expected matrix", () => {
    for (const v of Object.values(EXPECTED)) expect(v.anon).toBe(false);
  });
});
