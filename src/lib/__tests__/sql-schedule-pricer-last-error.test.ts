import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({ sync: {} as Record<string, any>, updates: [] as any[] }));

vi.mock("../p21.server", () => ({ applyPricerSync: async () => st.sync, runJob: async () => ({}) }));
vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q,
      single: async () => ({ data: { id: "s1", name: "Nightly Pricer Sync", action: "upsert_price_list", sql: "", schedule_cron: "0 6 * * *", timezone: "America/Chicago", params: {}, recipients: [] }, error: null }),
      update: (row: any) => { if (table === "sql_schedules") st.updates.push(row); return q; },
      insert: async () => ({ error: null }),
      then: (r: any) => Promise.resolve({ error: null }).then(r),
    };
    return q;
  };
  return { supabaseAdmin: { from } };
});

import { executeSchedule } from "../sql-schedules.server";

beforeEach(() => { st.updates = []; });

describe("Nightly Pricer Sync schedule last_error", () => {
  it("family relabel skipped -> last_error carries the skip text, last_status stays success", async () => {
    const phrase = "Family relabel SKIPPED: 14,210 changes > cap 809, needs approved forced run";
    st.sync = { imported: 16185, removed: 0, families_updated: 0, families_skipped: "x", families_skipped_message: phrase };
    const r = await executeSchedule("s1");
    expect(r.status).toBe("success");
    expect(st.updates.at(-1).last_error).toBe(phrase);
    expect(st.updates.at(-1).last_status).toBe("success");
  });
  it("not skipped -> last_error null on success", async () => {
    st.sync = { imported: 16185, removed: 2, families_updated: 5 };
    await executeSchedule("s1");
    expect(st.updates.at(-1).last_error).toBeNull();
    expect(st.updates.at(-1).last_status).toBe("success");
  });
});
