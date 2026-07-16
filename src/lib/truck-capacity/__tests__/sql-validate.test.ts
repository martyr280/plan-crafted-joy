import { describe, it, expect } from "vitest";
import { validateP21SqlText, validateP21SqlOutput } from "../sql-validate";
import { DEFAULT_P21_SQL, DEFAULT_P21_TRANSFER_SQL } from "../../truck-capacity.server";

describe("validateP21SqlText", () => {
  it("accepts the shipped DEFAULT_P21_SQL", () => {
    const { errors } = validateP21SqlText(DEFAULT_P21_SQL, "orders");
    expect(errors).toEqual([]);
  });

  it("accepts the shipped DEFAULT_P21_TRANSFER_SQL", () => {
    const { errors } = validateP21SqlText(DEFAULT_P21_TRANSFER_SQL, "transfers");
    expect(errors).toEqual([]);
  });

  it("rejects a query missing a required column (route_code)", () => {
    const sql = `SELECT ship_date, order_count, total_weight_lbs, total_cube_ft FROM x`;
    const { errors } = validateP21SqlText(sql);
    expect(errors.some((e) => e.includes("route_code"))).toBe(true);
  });

  it("accepts a query without est_pallets (est_pallets is optional)", () => {
    const sql = `SELECT route_code, ship_date, order_count, total_weight_lbs, total_cube_ft FROM x`;
    const { errors } = validateP21SqlText(sql);
    expect(errors).toEqual([]);
  });

  it("ignores aliases that only appear in a comment", () => {
    const sql = `-- route_code, ship_date, order_count, total_weight_lbs, total_cube_ft, est_pallets\nSELECT 1 FROM x`;
    const { errors } = validateP21SqlText(sql);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects empty SQL", () => {
    expect(validateP21SqlText("   ").errors.length).toBe(1);
  });
});

describe("validateP21SqlOutput", () => {
  const goodRow = () => ({
    route_code: "ETX01",
    ship_date: "2026-07-20",
    order_count: 3,
    total_weight_lbs: 12000,
    total_cube_ft: 800,
    est_pallets: null,
    ship_city: "Dallas",
    ship_state: "TX",
    ship_zip: "75201",
  });

  it("accepts a well-formed sample", () => {
    const { errors, warnings } = validateP21SqlOutput([goodRow(), goodRow()]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("warns on empty result set", () => {
    const { errors, warnings } = validateP21SqlOutput([]);
    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it("flags a missing required column", () => {
    const row: any = goodRow(); delete row.est_pallets;
    const { errors } = validateP21SqlOutput([row]);
    expect(errors.some((e) => e.includes("est_pallets"))).toBe(true);
  });

  it("flags an unparseable ship_date", () => {
    const { errors } = validateP21SqlOutput([{ ...goodRow(), ship_date: "not-a-date" }]);
    expect(errors.some((e) => e.includes("ship_date"))).toBe(true);
  });

  it("flags a non-numeric order_count", () => {
    const { errors } = validateP21SqlOutput([{ ...goodRow(), order_count: "banana" }]);
    expect(errors.some((e) => e.includes("order_count"))).toBe(true);
  });

  it("permits numeric strings for numeric columns", () => {
    const { errors } = validateP21SqlOutput([{ ...goodRow(), total_weight_lbs: "1,234.5" as any }]);
    expect(errors).toEqual([]);
  });

  it("warns when every sampled row has null capacity signals", () => {
    const row = { ...goodRow(), total_weight_lbs: null, total_cube_ft: null, est_pallets: null };
    const { warnings } = validateP21SqlOutput([row]);
    expect(warnings.some((w) => w.includes("NULL weight, cube, AND pallets"))).toBe(true);
  });

  it("warns on a malformed ship_state", () => {
    const { warnings } = validateP21SqlOutput([{ ...goodRow(), ship_state: "Texas" }]);
    expect(warnings.some((w) => w.includes("ship_state"))).toBe(true);
  });

  it("flags an empty route_code", () => {
    const { errors } = validateP21SqlOutput([{ ...goodRow(), route_code: "" }]);
    expect(errors.some((e) => e.includes("route_code"))).toBe(true);
  });

  it("notes unused extra columns as a warning", () => {
    const { warnings } = validateP21SqlOutput([{ ...goodRow(), debug_flag: 1 }]);
    expect(warnings.some((w) => w.includes("unused columns"))).toBe(true);
  });
});
