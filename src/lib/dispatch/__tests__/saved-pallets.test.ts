import { describe, expect, it } from "vitest";
import {
  buildDispatchPlanFromRows,
  type AddressMapEntry,
  type CutoffWindow,
  type P21DispatchRow,
} from "../build";
import { buildLoadSheet } from "../loadsheet";
import { rehydrateDispatchPallets } from "../pallets";
import { formatEstPallets, formatPalletTotal } from "@/lib/truck-capacity/est-pallets";
import type { SequenceTemplateRow } from "../sequence";

const OKL = { cubeFullTruckFt3: 4050, palletsFullTruck: 26 };
const JAX = { cubeFullTruckFt3: 1830, palletsFullTruck: 13 };

const TEMPLATE: SequenceTemplateRow[] = [
  { city_norm: "SPRINGFIELD", state: "MO", position: 1, delivery_dow_label: "Wed" },
];
const CUTOFF: CutoffWindow = {
  routeCode: "OKL",
  runDates: ["2026-11-11"],
  cutoffAtIso: "2026-11-10T21:00:00.000Z",
  lockAtIso: null,
};
const MAP: AddressMapEntry[] = [
  { p21_ship_to_id: "ST1", samsara_address_id: "addr_1", verified: true },
];

function row(over: Partial<P21DispatchRow> = {}): P21DispatchRow {
  return {
    pick_ticket_no: "PT1",
    order_no: "O1",
    route_code: "OKL",
    ship_date: "2026-11-11",
    customer_id: "C1",
    customer_name: "Synthetic",
    ship_to_id: "ST1",
    ship2_name: "Synthetic",
    ship2_addr1: "1 Main",
    ship2_addr2: null,
    ship2_city: "Springfield",
    ship2_state: "MO",
    ship2_zip: "65802",
    delivery_instructions: null,
    est_weight_lbs: 500,
    est_cube_ft: 2025,
    est_pallets: 0,
    line_count: 5,
    fulfillment_status: "FULL",
    qty_short: 0,
    ...over,
  } as P21DispatchRow;
}

describe("saved dispatch pallet estimates", () => {
  it("OKL half cube is 13 and ignores a stale stored 0", () => {
    const plan = buildDispatchPlanFromRows([row()], MAP, TEMPLATE, CUTOFF, {
      tz: "America/Chicago",
      depotDepartLocal: "07:00",
      stopIncrementMin: 20,
      ...OKL,
    });
    const stop = plan.runs[0]!.stops[0]!;
    expect(stop.estPallets).toBe(13);
    expect(plan.runs[0]!.totals.estPallets).toBe(13);
    expect(plan.runs[0]!.totals.palletStatus).toBe("known");
  });

  it("JAX half cube is 6.5", () => {
    const plan = buildDispatchPlanFromRows(
      [row({ est_cube_ft: 915, route_code: "JAX" })],
      MAP,
      TEMPLATE,
      { ...CUTOFF, routeCode: "JAX" },
      { tz: "America/Chicago", depotDepartLocal: "07:00", stopIncrementMin: 20, ...JAX },
    );
    expect(plan.runs[0]!.stops[0]!.estPallets).toBe(6.5);
  });

  it("missing, zero, and negative inputs stay unavailable", () => {
    const base = { tz: "America/Chicago", depotDepartLocal: "07:00", stopIncrementMin: 20, ...OKL };
    expect(
      buildDispatchPlanFromRows([row({ est_cube_ft: null })], MAP, TEMPLATE, CUTOFF, base).runs[0]!
        .totals.palletStatus,
    ).toBe("unavailable");
    expect(
      buildDispatchPlanFromRows([row({ est_cube_ft: 0 })], MAP, TEMPLATE, CUTOFF, base).runs[0]!
        .stops[0]!.estPallets,
    ).toBeNull();
    expect(
      buildDispatchPlanFromRows([row({ est_cube_ft: -10 })], MAP, TEMPLATE, CUTOFF, base).runs[0]!
        .stops[0]!.estPallets,
    ).toBeNull();
    expect(
      buildDispatchPlanFromRows([row()], MAP, TEMPLATE, CUTOFF, { ...base, palletsFullTruck: 0 })
        .runs[0]!.stops[0]!.estPallets,
    ).toBeNull();
    expect(
      buildDispatchPlanFromRows([row()], MAP, TEMPLATE, CUTOFF, { ...base, cubeFullTruckFt3: null })
        .runs[0]!.stops[0]!.estPallets,
    ).toBeNull();
  });

  it("a mix is partial and does not count the unknown stop as zero", () => {
    const plan = buildDispatchPlanFromRows(
      [row({ order_no: "A" }), row({ order_no: "B", est_cube_ft: null, est_pallets: 99 })],
      MAP,
      TEMPLATE,
      CUTOFF,
      { tz: "America/Chicago", depotDepartLocal: "07:00", stopIncrementMin: 20, ...OKL },
    );
    const total = plan.runs[0]!.totals;
    expect(total.palletStatus).toBe("partial");
    expect(total.estPallets).toBeNull();
    expect(total.palletKnown).toBe(13);
  });

  it("rehydrates a saved run from cube and current capacity, not the cached pallet column", () => {
    const fresh = rehydrateDispatchPallets(
      [
        { est_cube_ft: 2025, est_pallets: 0 },
        { est_cube_ft: 915, est_pallets: 99 },
      ],
      OKL,
    );
    expect(fresh.stops.map((s) => s.est_pallets)).toEqual([13, 915 / (4050 / 26)]);
    expect(fresh.total.status).toBe("known");
    const jax = rehydrateDispatchPallets([{ est_cube_ft: 915, est_pallets: 0 }], JAX);
    expect(jax.stops[0]!.est_pallets).toBe(6.5);
    expect(formatEstPallets(jax.stops[0]!.est_pallets)).toBe("6.5");
  });

  it("load sheet prints unavailable or partial instead of a zero total", () => {
    const missing = buildLoadSheet([{ position: 1, hold: false, estPallets: null }]);
    expect(missing.totals.pallets).toBeNull();
    expect(formatPalletTotal(missing.totals.palletTotal)).toBe("unavailable");
    const mixed = buildLoadSheet([
      { position: 1, hold: false, estPallets: 13 },
      { position: 2, hold: false, estPallets: null },
    ]);
    expect(mixed.totals.pallets).toBeNull();
    expect(mixed.totals.palletTotal.known).toBe(13);
    expect(formatPalletTotal(mixed.totals.palletTotal)).toBe(
      "At least 13 estimated pallets (1 of 2 stops); some stops unavailable",
    );
  });
});
