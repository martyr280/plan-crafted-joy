import { afterEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const admins: { current: { from: (table: string) => unknown } | null } = { current: null };
const orders: string[] = [];

function builder(table: string, rows: Row[], error: { message: string } | null) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lte: () => chain,
    not: () => chain,
    order: (column: string) => {
      if (table === "truck_capacity_p21_demand") orders.push(column);
      return chain;
    },
    limit: () => chain,
    range: async () => ({ data: error ? null : rows, error, count: error ? null : rows.length }),
    insert: () => Promise.resolve({ error: null }),
    upsert: () => Promise.resolve({ error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (res: (v: { data: Row[]; error: null }) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(res, rej),
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return admins.current;
  },
}));

const route = {
  id: "R1",
  code: "OKL",
  hub: "Dallas",
  truck_type: null,
  typical_dow: [],
  cube_full_truck_ft3: 4050,
  pallets_full_truck: 26,
};

afterEach(() => {
  vi.useRealTimers();
  admins.current = null;
  orders.length = 0;
});

describe("loadP21Cubes", () => {
  it("throws when the cube read fails instead of looking like an unconfigured route", async () => {
    admins.current = {
      from: (table: string) => {
        if (table === "truck_capacity_routes") return builder(table, [route], null);
        if (table === "truck_capacity_p21_demand")
          return builder(table, [], { message: "cube read failed" });
        return builder(table, [], null);
      },
    };
    const { computeForecastForRoute } = await import("../serve");
    await expect(
      computeForecastForRoute("R1", 2, "baseline", { logForecast: false }),
    ).rejects.toThrow(/cube read failed/);
  });

  it("pages with snapshot_at then id and keeps the newer cube", async () => {
    // Forecast days start the day after "today" in America/Chicago; pin today to
    // 2026-11-10 (noon CST) so the 2026-11-11 ship date is always in the window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
    admins.current = {
      from: (table: string) => {
        if (table === "truck_capacity_routes") return builder(table, [route], null);
        if (table === "truck_capacity_p21_demand") {
          return builder(
            table,
            [
              {
                id: "older",
                ship_date: "2026-11-11",
                total_cube_ft: 100,
                snapshot_at: "2026-11-01T00:00:00Z",
              },
              {
                id: "newer",
                ship_date: "2026-11-11",
                total_cube_ft: 2025,
                snapshot_at: "2026-11-09T00:00:00Z",
              },
            ],
            null,
          );
        }
        return builder(table, [], null);
      },
    };
    const { computeForecastForRoute } = await import("../serve");
    const res = await computeForecastForRoute("R1", 21, "baseline", { logForecast: false });
    const day = res.days.find((d) => d.date === "2026-11-11");
    expect(day?.est_pallets).toBe(13);
    expect(orders).toContain("snapshot_at");
    expect(orders).toContain("id");
  });
});
