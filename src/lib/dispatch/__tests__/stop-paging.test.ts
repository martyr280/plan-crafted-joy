import { describe, expect, it } from "vitest";
import { fetchAllRows, type PagedQuery } from "../../supabase-fetch-all";
import { rehydrateDispatchPallets } from "../pallets";

type Stop = {
  id: string;
  dispatch_run_id: string;
  est_cube_ft: number | null;
  est_pallets: number | null;
};

function paged(rows: Stop[], count = rows.length): () => PagedQuery<Stop> {
  return () => {
    const q: PagedQuery<Stop> = {
      order: () => q,
      range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null, count }),
    };
    return q;
  };
}

const OKL = { cubeFullTruckFt3: 4050, palletsFullTruck: 26 };

describe("paged dispatch stops", () => {
  it("keeps an unknown stop past the first 1,000 rows from looking like a complete total", async () => {
    const rows: Stop[] = Array.from({ length: 1001 }, (_, i) => ({
      id: String(i).padStart(5, "0"),
      dispatch_run_id: "run-1",
      est_cube_ft: i === 1000 ? null : 2025,
      est_pallets: 0,
    }));
    const loaded = await fetchAllRows(paged(rows), {
      orderBy: [{ column: "created_at" }, { column: "id" }],
      label: "dispatch stop cubes",
    });
    expect(loaded).toHaveLength(1001);
    const fresh = rehydrateDispatchPallets(loaded, OKL);
    expect(fresh.total.status).toBe("partial");
    expect(fresh.total.total).toBeNull();
    expect(fresh.total.known).toBe(13 * 1000);
  });

  it("refuses a short read instead of returning a complete total", async () => {
    const rows: Stop[] = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      dispatch_run_id: "run-1",
      est_cube_ft: 2025,
      est_pallets: 0,
    }));
    await expect(
      fetchAllRows(paged(rows, 1001), {
        orderBy: [{ column: "position" }, { column: "id" }],
        label: "dispatch run detail stops",
      }),
    ).rejects.toThrow(/fetched 1000 of 1001/);
  });
});
