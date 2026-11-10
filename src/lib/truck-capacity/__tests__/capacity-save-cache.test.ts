import { describe, expect, it, vi } from "vitest";
import { CAPACITY_SAVE_QUERY_KEYS, invalidateAfterCapacitySave } from "../capacity-save";

describe("capacity save cache", () => {
  it("invalidates forecast, board, and dispatch reads after a pallets/full save", () => {
    const invalidate = vi.fn();
    invalidateAfterCapacitySave(invalidate);
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([
      ["tc-settings"],
      ["tc-routes"],
      ["tc-forecast"],
      ["truck-forecast-board"],
      ["dispatch"],
    ]);
    expect(CAPACITY_SAVE_QUERY_KEYS.map((key) => key[0])).toContain("truck-forecast-board");
  });
});
