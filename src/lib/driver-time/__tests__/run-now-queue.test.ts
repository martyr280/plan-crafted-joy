import "./network-block";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSweepDb, sweepDb } from "./fixtures/sweep-db";
import { samsara } from "./fixtures/sweep-samsara";

vi.mock("@tanstack/react-start", async () => ({
  createServerFn: (await import("./fixtures/weekly-db")).serverFnChain,
}));
vi.mock("@/lib/branch-guard", () => ({ denyLegacyBranchAccess: {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { sweepDbClient } = await import("./fixtures/sweep-db");
  return { supabaseAdmin: { ...sweepDbClient, rpc: async () => ({ data: true, error: null }) } };
});
vi.mock("@/lib/samsara/hos.server", async () => (await import("./fixtures/sweep-samsara")).samsaraMock);

import { runDriverTimeSweepNow } from "@/lib/driver-time.functions";

describe("12. Run now queues and returns at once", () => {
  beforeEach(() => resetSweepDb({ driver_warehouse_runs: [], user_roles: [{ user_id: "u-1", role: "admin" }] }));

  it("returns the run id without running any unit; a duplicate week returns the same id", async () => {
    const call = (weekStart: string) => (runDriverTimeSweepNow as any)({ data: { weekStart }, context: { userId: "u-1" } });
    const before = samsara.calls;
    const a = await call("2026-09-28");
    expect(a).toMatchObject({ ok: true, queued: true, existing: false, weekStart: "2026-09-28", weekEnd: "2026-10-04" });
    expect(typeof a.runId).toBe("string");
    const b = await call("2026-09-28");
    expect(b).toMatchObject({ ok: true, existing: true, runId: a.runId });
    expect(sweepDb.tables.driver_warehouse_runs).toHaveLength(1);
    expect(sweepDb.tables.driver_warehouse_runs[0]).toMatchObject({ status: "queued", phase: "init", requested_week_start: "2026-09-28", steps: 0 });
    expect(samsara.calls).toBe(before); // no Samsara work happened
  });
});
