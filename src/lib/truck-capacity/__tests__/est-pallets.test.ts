import { describe, expect, it } from "vitest";
import {
  EST_PALLETS_UNAVAILABLE,
  estimatePallets,
  estimateRunPallets,
  formatEstPallets,
  latestDemandCube,
  resolveDisplayedEstPallets,
} from "../est-pallets";
import { buildDispatchBoard, type BoardCutoff, type DemandRow } from "@/lib/dispatch/board";
import type { P21DispatchRow } from "@/lib/dispatch/build";

function ticket(
  partial: Partial<P21DispatchRow> & Pick<P21DispatchRow, "pick_ticket_no" | "route_code">,
): P21DispatchRow {
  return {
    order_no: null,
    ship_date: null,
    customer_id: null,
    customer_name: null,
    ship_to_id: null,
    ship2_name: null,
    ship2_addr1: null,
    ship2_addr2: null,
    ship2_city: null,
    ship2_state: null,
    ship2_zip: null,
    delivery_instructions: null,
    est_weight_lbs: null,
    est_cube_ft: null,
    est_pallets: null,
    line_count: null,
    ...partial,
  };
}

const OKL = { cube: 2025, cubeFullTruckFt3: 4050, palletsFullTruck: 26 };
const JAX = { cube: 915, cubeFullTruckFt3: 1830, palletsFullTruck: 13 };

describe("estimatePallets", () => {
  it("OKL half cube is 2025 / (4050 / 26) = 13", () => {
    expect(estimatePallets(OKL)).toBe(13);
  });
  it("JAX half cube is 915 / (1830 / 13) = 6.5", () => {
    expect(estimatePallets(JAX)).toBe(6.5);
  });
  it("full cube returns the route's pallets/full, including a fraction", () => {
    expect(estimatePallets({ cube: 4050, cubeFullTruckFt3: 4050, palletsFullTruck: 26 })).toBe(26);
    expect(estimatePallets({ cube: 1830, cubeFullTruckFt3: 1830, palletsFullTruck: 13 })).toBe(13);
    expect(
      estimatePallets({ cube: 100, cubeFullTruckFt3: 4050, palletsFullTruck: 26 }),
    ).toBeCloseTo(100 / (4050 / 26), 10);
    expect(estimatePallets({ cube: 100, cubeFullTruckFt3: 4050, palletsFullTruck: 26 })).not.toBe(
      Math.trunc(100 / (4050 / 26)),
    );
  });
  it("uses numeric division, not integer truncation of cube per pallet", () => {
    const integerTrap = 915 / Math.floor(1830 / 13);
    expect(integerTrap).not.toBe(6.5);
    expect(estimatePallets(JAX)).toBe(6.5);
  });
  it("accepts numeric strings from the database", () => {
    expect(
      estimatePallets({ cube: "2025", cubeFullTruckFt3: "4050", palletsFullTruck: "26" }),
    ).toBe(13);
  });
  it("zero cube is unavailable, not 0", () => {
    expect(estimatePallets({ ...OKL, cube: 0 })).toBeNull();
    expect(estimatePallets({ ...OKL, cube: "0" })).toBeNull();
  });
  it("missing, zero, or negative capacity is unavailable", () => {
    expect(estimatePallets({ ...OKL, palletsFullTruck: null })).toBeNull();
    expect(estimatePallets({ ...OKL, cubeFullTruckFt3: null })).toBeNull();
    expect(estimatePallets({ ...OKL, cube: null })).toBeNull();
    expect(estimatePallets({ ...OKL, palletsFullTruck: 0 })).toBeNull();
    expect(estimatePallets({ ...OKL, cubeFullTruckFt3: 0 })).toBeNull();
    expect(estimatePallets({ ...OKL, cube: -2025 })).toBeNull();
    expect(estimatePallets({ ...OKL, palletsFullTruck: -26 })).toBeNull();
    expect(estimatePallets({ ...OKL, cubeFullTruckFt3: -4050 })).toBeNull();
    expect(
      estimatePallets({
        cube: undefined,
        cubeFullTruckFt3: undefined,
        palletsFullTruck: undefined,
      }),
    ).toBeNull();
  });
  it("a route edit changes the estimate and does not invent a fallback", () => {
    expect(estimatePallets({ ...OKL, palletsFullTruck: 13 })).toBe(2025 / (4050 / 13));
    expect(estimatePallets({ ...OKL, cubeFullTruckFt3: 2025 })).toBe(26);
  });
  it("ignores a stale stored pallet count, including 0", () => {
    expect(resolveDisplayedEstPallets({ ...OKL, storedEstPallets: null })).toBe(13);
    expect(resolveDisplayedEstPallets({ ...OKL, storedEstPallets: 0 })).toBe(13);
    expect(resolveDisplayedEstPallets({ ...OKL, storedEstPallets: 99 })).toBe(13);
    expect(
      resolveDisplayedEstPallets({ ...OKL, palletsFullTruck: null, storedEstPallets: 13 }),
    ).toBeNull();
    expect(resolveDisplayedEstPallets({ ...OKL, cube: 0, storedEstPallets: 0 })).toBeNull();
    expect(resolveDisplayedEstPallets({ ...OKL, cube: null, storedEstPallets: 0 })).toBeNull();
  });
  it("a run with a zero-cube day is unavailable rather than a partial sum", () => {
    expect(
      estimateRunPallets([{ cube: 2025 }, { cube: 0 }], {
        cubeFullTruckFt3: 4050,
        palletsFullTruck: 26,
      }),
    ).toBeNull();
    expect(estimateRunPallets([], { cubeFullTruckFt3: 4050, palletsFullTruck: 26 })).toBeNull();
    expect(
      estimateRunPallets([{ cube: 2025 }, { cube: 2025 }], {
        cubeFullTruckFt3: 4050,
        palletsFullTruck: 26,
      }),
    ).toBe(26);
  });
  it("breaks snapshot ties on id and ignores a stored pallet count", () => {
    const cubes = latestDemandCube([
      { id: "a", ship_date: "2026-11-11", total_cube_ft: 100, snapshot_at: "2026-11-09T00:00:00Z" },
      {
        id: "b",
        ship_date: "2026-11-11",
        total_cube_ft: 2025,
        snapshot_at: "2026-11-09T00:00:00Z",
      },
    ]);
    expect(cubes.get("2026-11-11")).toBe(2025);
  });
  it("formats unavailable instead of 0", () => {
    expect(formatEstPallets(null)).toBe(EST_PALLETS_UNAVAILABLE);
    expect(formatEstPallets(0)).toBe(EST_PALLETS_UNAVAILABLE);
    expect(formatEstPallets(undefined)).toBe(EST_PALLETS_UNAVAILABLE);
    expect(formatEstPallets(13)).toBe("13");
    expect(formatEstPallets(6.5)).toBe("6.5");
  });
});

describe("dispatch board demand pallets", () => {
  it("OKL demand shows 13 and does not keep a stale stored 0", () => {
    const oklCutoff: BoardCutoff = {
      route_id: "r-okl",
      p21_code: "OKL",
      cutoff_dow: 1,
      cutoff_time: "15:00:00",
      run_dows: [2],
      active: true,
    };
    const board = buildDispatchBoard(
      [
        ticket({
          pick_ticket_no: "T1",
          order_no: "O1",
          route_code: "OKL",
          pick_ticket_print_date: "2026-11-09",
          est_cube_ft: 100,
          est_weight_lbs: 50,
        }),
      ],
      [oklCutoff],
      [
        {
          route_id: "r-okl",
          ship_date: "2026-11-10",
          order_count: 4,
          total_cube_ft: 2025,
          projected_capacity_frac: 0.5,
          snapshot_at: "2026-11-09T12:00:00Z",
          cube_full_truck_ft3: 4050,
          pallets_full_truck: 26,
          est_pallets: 0,
        } satisfies DemandRow,
      ],
      { basis: "pick_ticket_print", today: "2026-11-09" },
    );
    const run = board.upcoming.find((r) => r.route_code === "OKL" && r.run_date === "2026-11-10");
    expect(run?.demand?.est_pallets).toBe(13);
    expect(JSON.stringify(run?.demand)).not.toContain('"est_pallets":0');
  });
  it("a route with no pallets/full shows null, not 0", () => {
    const wtxCutoff: BoardCutoff = {
      route_id: "r-wtx",
      p21_code: "WTX",
      cutoff_dow: 1,
      cutoff_time: "15:00:00",
      run_dows: [2],
      active: true,
    };
    const board = buildDispatchBoard(
      [
        ticket({
          pick_ticket_no: "T1",
          order_no: "O1",
          route_code: "WTX",
          pick_ticket_print_date: "2026-11-09",
        }),
      ],
      [wtxCutoff],
      [
        {
          route_id: "r-wtx",
          ship_date: "2026-11-10",
          order_count: 2,
          total_cube_ft: 900,
          projected_capacity_frac: 0.2,
          snapshot_at: "2026-11-09T12:00:00Z",
          cube_full_truck_ft3: 4050,
          pallets_full_truck: null,
          est_pallets: 0,
        } satisfies DemandRow,
      ],
      { basis: "pick_ticket_print", today: "2026-11-09" },
    );
    const run = board.upcoming.find((r) => r.route_code === "WTX");
    expect(run?.demand?.est_pallets).toBeNull();
  });
});
