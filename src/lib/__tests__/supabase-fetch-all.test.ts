import { describe, it, expect } from "vitest";
import { fetchAllRows } from "../supabase-fetch-all";

const source = (total: number) => {
  const all = Array.from({ length: total }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const q = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: all.slice(from, to + 1), error: null };
  };
  return { q, calls };
};

describe("fetchAllRows", () => {
  it("returns 2,350 rows across 3 pages in order", async () => {
    const { q, calls } = source(2350);
    const rows = await fetchAllRows(q);
    expect(rows.length).toBe(2350);
    expect(rows).toEqual(Array.from({ length: 2350 }, (_, i) => i));
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("exactly 1,000 rows stops after an empty second page", async () => {
    const { q, calls } = source(1000);
    const rows = await fetchAllRows(q);
    expect(rows.length).toBe(1000);
    expect(calls.length).toBe(2);
  });

  it("throws when page 2 errors", async () => {
    let n = 0;
    const q = async () => (++n === 2
      ? { data: null, error: { message: "boom" } }
      : { data: Array(1000).fill(0), error: null });
    await expect(fetchAllRows(q)).rejects.toThrow(/page 2 failed: boom/);
  });

  it("throws at the hard page cap instead of looping forever", async () => {
    const q = async () => ({ data: Array(10).fill(0), error: null });
    await expect(fetchAllRows(q, 10, 5)).rejects.toThrow(/exceeded 5 pages/);
  });
});
