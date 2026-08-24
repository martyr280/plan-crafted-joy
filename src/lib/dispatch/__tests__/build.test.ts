import { describe, expect, it } from "vitest";
import {
  buildDispatchPlanFromRows,
  externalIdFor,
  type AddressMapEntry,
  type CutoffWindow,
  type P21DispatchRow,
} from "../build";
import type { SequenceTemplateRow } from "../sequence";

const WED = "2026-08-26";
const THU = "2026-08-27";

const TEMPLATE: SequenceTemplateRow[] = [
  { city_norm: "SPRINGFIELD", state: "MO", position: 1, delivery_dow_label: "Wed" },
  { city_norm: "BRANSON", state: "MO", position: 2, delivery_dow_label: "Wed" },
  { city_norm: "COLUMBIA", state: "MO", position: 1, delivery_dow_label: "Thu" },
];

const CUTOFF: CutoffWindow = {
  routeCode: "MSL01",
  runDates: [WED, THU],
  cutoffAtIso: "2026-08-25T21:00:00.000Z",
  lockAtIso: null,
};

const CONFIG = { tz: "America/Chicago", depotDepartLocal: "07:00", stopIncrementMin: 20 };

function row(over: Partial<P21DispatchRow> = {}): P21DispatchRow {
  return {
    pick_ticket_no: "PT1",
    order_no: "O1",
    route_code: "MSL01",
    ship_date: WED,
    customer_id: "C1",
    customer_name: "Springfield Supply",
    ship_to_id: "ST1",
    ship2_name: "Springfield Supply",
    ship2_addr1: "123 Main St",
    ship2_addr2: null,
    ship2_city: "Springfield",
    ship2_state: "MO",
    ship2_zip: "65802",
    delivery_instructions: null,
    est_weight_lbs: 500,
    est_cube_ft: 40,
    est_pallets: 2,
    line_count: 5,
    total_lines_allocated: 5,
    ...over,
  } as P21DispatchRow;
}

const MAP: AddressMapEntry[] = [
  { p21_ship_to_id: "ST1", samsara_address_id: "addr_1", verified: true },
  { p21_ship_to_id: "ST2", samsara_address_id: "addr_2", verified: true },
  { p21_ship_to_id: "ST3", samsara_address_id: "addr_3", verified: true },
];

describe("externalIdFor", () => {
  it("is the documented deterministic shape", () => {
    expect(externalIdFor("MSL01", WED, 1)).toBe(`nelsonDispatch:MSL01:${WED}:1`);
  });
});

describe("buildDispatchPlanFromRows", () => {
  it("produces one run per run day with stable external ids", () => {
    const rows = [
      row(),
      row({ order_no: "O2", ship_to_id: "ST2", customer_name: "Branson Furniture", ship2_city: "Branson", ship2_zip: "65616" }),
      row({ order_no: "O3", ship_to_id: "ST3", customer_name: "Columbia Interiors", ship2_city: "Columbia", ship2_zip: "65201", ship_date: THU }),
    ];
    const plan = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG);
    expect(plan.runs.map((r) => r.runDate)).toEqual([WED, THU]);
    expect(plan.runs.map((r) => r.externalId)).toEqual([
      `nelsonDispatch:MSL01:${WED}:1`,
      `nelsonDispatch:MSL01:${THU}:1`,
    ]);
    expect(plan.runs[0]!.stops.map((s) => s.orderNo)).toEqual(["O1", "O2"]);
    expect(plan.runs[1]!.stops.map((s) => s.orderNo)).toEqual(["O3"]);
  });

  it("is byte-identical for identical inputs", () => {
    const rows = [row(), row({ order_no: "O2", ship_to_id: "ST2", ship2_city: "Branson", ship2_zip: "65616" })];
    const a = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG);
    const b = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("excludes cancelled rows and rows with no lines", () => {
    const rows = [
      row(),
      row({ order_no: "CANCEL", cancel_flag: "Y" } as Partial<P21DispatchRow>),
      row({ order_no: "EMPTY", line_count: 0, total_lines_allocated: 0 }),
    ];
    const plan = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG);
    const all = plan.runs.flatMap((r) => [...r.stops, ...r.holds]).map((s) => s.orderNo);
    expect(all).toEqual(["O1"]);
  });

  it("holds partial allocations without dropping them", () => {
    const rows = [row({ order_no: "PART", total_lines_allocated: 2 })];
    const plan = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG);
    const wed = plan.runs[0]!;
    expect(wed.stops).toHaveLength(0);
    expect(wed.holds).toHaveLength(1);
    expect(wed.holds[0]!.holdReason).toBe("partial_allocation");
    expect(wed.holds[0]!.stopNotes).toMatch(/2 of 5/);
    expect(wed.totals.stopsHeld).toBe(1);
    expect(wed.totals.ordersTotal).toBe(1);
  });

  it("holds unmapped addresses and preserves the raw address text", () => {
    const rows = [row({ order_no: "NOMAP", ship_to_id: "ST9" })];
    const plan = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG);
    const hold = plan.runs[0]!.holds[0]!;
    expect(hold.holdReason).toBe("unmapped_address");
    expect(hold.stopNotes).toMatch(/123 Main St/);
    expect(hold.stopNotes).toMatch(/SPRINGFIELD MO 65802/);
    expect(hold.samsaraAddressId).toBeNull();
  });

  it("treats an unverified map row as unmapped", () => {
    const plan = buildDispatchPlanFromRows(
      [row()],
      [{ p21_ship_to_id: "ST1", samsara_address_id: "addr_1", verified: false }],
      TEMPLATE,
      CUTOFF,
      CONFIG,
    );
    expect(plan.runs[0]!.holds[0]!.holdReason).toBe("unmapped_address");
  });

  it("keeps delivery instructions in the stop notes", () => {
    const plan = buildDispatchPlanFromRows(
      [row({ delivery_instructions: "Dock 4, call ahead" })],
      MAP,
      TEMPLATE,
      CUTOFF,
      CONFIG,
    );
    expect(plan.runs[0]!.stops[0]!.stopNotes).toMatch(/Dock 4, call ahead/);
  });

  it("sums totals across live stops and holds", () => {
    const rows = [
      row(),
      row({ order_no: "O2", ship_to_id: "ST9", est_pallets: 3, est_cube_ft: 60, est_weight_lbs: 900 }),
    ];
    const wed = buildDispatchPlanFromRows(rows, MAP, TEMPLATE, CUTOFF, CONFIG).runs[0]!;
    expect(wed.totals.estPallets).toBe(5);
    expect(wed.totals.estCubeFt).toBe(100);
    expect(wed.totals.estWeightLbs).toBe(1400);
  });
});
