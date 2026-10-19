import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  snapshot: vi.fn(),
  history: vi.fn(),
  mutation: vi.fn(),
  lookup: { data: { id: "draft-run", status: "draft", totals: {} as { generated_at?: string } }, error: null as { message: string } | null },
}));
vi.mock("../spiff/fetch-all.server", () => ({ fetchAllRunLines: ports.snapshot, fetchAllRows: ports.history }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const query = {
        select: () => query, eq: () => query, order: () => query, limit: () => query,
        maybeSingle: async () => ports.lookup,
        insert: ports.mutation, update: ports.mutation, delete: ports.mutation,
      };
      return query;
    },
  },
}));
import { findOrCreateDraftRun } from "../spiff.server";

describe("SPIFF draft snapshot safety", () => {
  beforeEach(() => { vi.clearAllMocks(); ports.lookup.error = null; ports.lookup.data.totals = {}; ports.history.mockResolvedValue([]); });
  const opts = { quarterLabel: "Q3-2026", dateFrom: "2026-07-01", dateTo: "2026-10-01", userId: "fake-admin" };
  it("aborts failed snapshot before any deletion or update", async () => {
    ports.snapshot.mockRejectedValueOnce(new Error("fetched 1000 of 1550 rows"));
    await expect(findOrCreateDraftRun(opts)).rejects.toThrow("fetched 1000 of 1550 rows");
    expect(ports.mutation).not.toHaveBeenCalled();
  });
  it("keeps all 1550 snapshot rows and does not mutate during preparation", async () => {
    const rows = Array.from({ length: 1550 }, (_, id) => ({ id }));
    ports.snapshot.mockResolvedValueOnce(rows);
    expect(await findOrCreateDraftRun(opts)).toEqual({ id: "draft-run", isNew: false, snapshot: rows, editHistory: [], runGeneratedAt: null });
    expect(ports.snapshot).toHaveBeenCalledWith("draft-run", "*");
    expect(ports.mutation).not.toHaveBeenCalled();
  });
  it("aborts failed edit-history paging before any mutation", async () => {
    ports.history.mockRejectedValueOnce(new Error("edits incomplete"));
    await expect(findOrCreateDraftRun(opts)).rejects.toThrow("edits incomplete");
    expect(ports.mutation).not.toHaveBeenCalled();
  });
  it("reads generation time from the replaced draft's totals.generated_at, without mutation", async () => {
    ports.lookup.data.totals = { generated_at: "2026-10-01T12:00:00Z" };
    ports.snapshot.mockResolvedValueOnce([]);
    expect((await findOrCreateDraftRun(opts)).runGeneratedAt).toBe("2026-10-01T12:00:00Z");
    expect(ports.mutation).not.toHaveBeenCalled();
  });
  it("fails a lookup error rather than creating a replacement run", async () => {
    ports.lookup.error = { message: "lookup failed" };
    await expect(findOrCreateDraftRun(opts)).rejects.toThrow("lookup failed");
    expect(ports.snapshot).not.toHaveBeenCalled();
    expect(ports.mutation).not.toHaveBeenCalled();
  });
});