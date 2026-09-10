import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  parseTruckCapacityWorkbook, normalizeSheetName, matchHeader, parseDateCell,
  normalizeCapacity, normalizeDriver, excelSerialToIso, type SheetMap,
} from "../workbook-parse";

const ROUTE_A = "11111111-1111-4111-8111-111111111111"; // layout (a) + OKL typo
const ROUTE_B = "22222222-2222-4222-8222-222222222222"; // layout (b)
const ROUTE_C = "33333333-3333-4333-8333-333333333333"; // duplicate dates

function sheetMap(): SheetMap {
  return new Map([
    ["okl", { route_id: ROUTE_A, active: true }],
    ["ocala special runs", { route_id: ROUTE_B, active: true }],
    ["west carolina", { route_id: ROUTE_C, active: true }],
    ["carolinas", { route_id: null, active: false }],
  ]);
}

/** Fixture workbook covering every documented shape in the real file. */
async function fixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  // Layout (a) with the real OKL header typo "Unused Capcity".
  const okl = wb.addWorksheet("OKL");
  okl.addRow(["Date", "Capacity", "Unused Capcity", "Vendor Pickup Capacity", "Driver", "Pallet Count", "Notes", "Returned Pallets"]);
  okl.addRow([45700, 0.85, 0.15, 0.1, "  dj   smith ", 18, "on time", 2]);          // Excel serial date
  okl.addRow(["2/12/2026 - Run 1", 92, 0.08, null, "ALBERTO FISCAL", 20, null, 0]);  // percent > 1, "- Run N"
  okl.addRow(["2/12/2026 - Run 2", 0.4, 0.6, null, "bob o'neal", 9, "second run", null]);
  okl.addRow(["2/16/2026", null, 1, null, null, null, "Labor Day", null]);           // no-run marker
  okl.addRow(["2/17/2026", 4000, 0, null, "x", null, "bad", null]);                  // rejected: > 100
  okl.addRow([null, 1, 0, null, null, null, null, null]);                            // formula tail, no date

  // Layout (b): Date | Driver | Capacity | Pallet Count | Notes | Returned Pallets
  const osr = wb.addWorksheet("Ocala Special Runs");
  osr.addRow(["Date", "Driver", "Capacity", "Pallet Count", "Notes", "Returned Pallets"]);
  osr.addRow(["3/3/2026", "TJ Blanks", 0.55, 12, "special", 1]);

  // Two rows, same date, no "Run N" text → run_seq 1 then 2 in sheet order.
  const wcar = wb.addWorksheet("West Carolina");
  wcar.addRow(["Date", "Capacity", "Unused Capacity", "Driver", "Pallet Count", "Notes", "Returned Pallets"]);
  wcar.addRow(["7/24/2026", 0.7, 0.3, "Robert Young", 15, null, null]);
  wcar.addRow(["7/24/2026", 0.35, 0.65, "Robert Young", 8, null, null]);

  // Hidden legacy sheet with no route: must be skipped, not unmatched.
  const car = wb.addWorksheet("Carolinas");
  car.state = "hidden";
  car.addRow(["Date", "Capacity"]);
  car.addRow(["1/2/2026", 0.9]);

  // A sheet nobody mapped → reported as unmatched.
  const ghost = wb.addWorksheet("Brand New Route");
  ghost.addRow(["Date", "Capacity"]);
  ghost.addRow(["1/3/2026", 0.5]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("header matching", () => {
  it("maps every documented header and ignores Unused Capacity (incl. the OKL typo)", () => {
    expect(matchHeader("Date")).toBe("date");
    expect(matchHeader("Capacity")).toBe("capacity");
    expect(matchHeader("Unused Capacity")).toBeNull();
    expect(matchHeader("Unused Capcity")).toBeNull();
    expect(matchHeader("Vendor Pickup Capacity")).toBe("vendor_pickup");
    expect(matchHeader("driver")).toBe("driver");
    expect(matchHeader("Pallet Count")).toBe("pallet_count");
    expect(matchHeader("Notes")).toBe("notes");
    expect(matchHeader("Returned Pallets")).toBe("returned_pallets");
  });
});

describe("date cells", () => {
  it("converts Excel serials on the 1899-12-30 epoch with no timezone shift", () => {
    expect(excelSerialToIso(45700)).toBe("2025-02-12");
    expect(parseDateCell(45700)).toEqual({ iso: "2025-02-12", seq: null });
  });
  it("reads 'M/D/YYYY - Run N'", () => {
    expect(parseDateCell("2/12/2026 - Run 3")).toEqual({ iso: "2026-02-12", seq: 3 });
    expect(parseDateCell("2/12/2026")).toEqual({ iso: "2026-02-12", seq: null });
  });
  it("returns null for undated cells", () => {
    expect(parseDateCell("")).toBeNull();
    expect(parseDateCell("Labor Day")).toBeNull();
  });
});

describe("capacity normalization", () => {
  it("keeps fractions, converts 1–100 as percent, rejects > 100, treats blank as no-run", () => {
    expect(normalizeCapacity(0.85)).toEqual({ kind: "ok", value: 0.85 });
    expect(normalizeCapacity(92)).toEqual({ kind: "ok", value: 0.92 });
    expect(normalizeCapacity(4000)).toEqual({ kind: "rejected", value: null, raw: 4000 });
    expect(normalizeCapacity(null)).toEqual({ kind: "empty", value: null });
    expect(normalizeCapacity("")).toEqual({ kind: "empty", value: null });
  });
});

describe("driver normalization", () => {
  it("title cases but keeps short all-caps initials", () => {
    expect(normalizeDriver("  dj   smith ")).toBe("Dj Smith");
    expect(normalizeDriver("DJ")).toBe("DJ");
    expect(normalizeDriver("ALBERTO FISCAL")).toBe("Alberto Fiscal");
    expect(normalizeDriver("TJ Blanks")).toBe("TJ Blanks");
    expect(normalizeDriver("   ")).toBeNull();
  });
});

describe("parseTruckCapacityWorkbook", () => {
  it("parses both layouts, sequences duplicate dates, and classifies every sheet", async () => {
    const parsed = await parseTruckCapacityWorkbook(await fixture(), sheetMap());

    const okl = parsed.sheets.find((s) => s.normalized === "okl")!;
    expect(okl.status).toBe("ok");
    expect(okl.rows).toBe(4);              // serial, run 1, run 2, no-run marker
    expect(okl.no_run_rows).toBe(1);
    expect(okl.rejected_capacity).toBe(1); // the 4000 row
    expect(okl.skipped_no_date).toBe(0);   // formula tail row has no date text at all

    const oklRows = parsed.rows.filter((r) => r.route_id === ROUTE_A);
    expect(oklRows.map((r) => [r.run_date, r.run_seq, r.capacity_frac])).toEqual([
      ["2025-02-12", 1, 0.85],
      ["2026-02-12", 1, 0.92],
      ["2026-02-12", 2, 0.4],
      ["2026-02-16", 1, null],
    ]);
    expect(oklRows[0].driver).toBe("Dj Smith");
    expect(oklRows[0].vendor_pickup_frac).toBe(0.1);
    expect(oklRows[0].pallet_count).toBe(18);
    expect(oklRows[0].returned_pallets).toBe(2);
    expect(oklRows[3].notes).toBe("Labor Day");

    // Layout (b): Driver before Capacity — located by header, not position.
    const b = parsed.rows.filter((r) => r.route_id === ROUTE_B);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ run_date: "2026-03-03", run_seq: 1, capacity_frac: 0.55, driver: "TJ Blanks", pallet_count: 12, notes: "special", returned_pallets: 1 });

    // Duplicate dates with no "Run N" → 1, 2 in sheet order.
    const c = parsed.rows.filter((r) => r.route_id === ROUTE_C);
    expect(c.map((r) => [r.run_seq, r.capacity_frac])).toEqual([[1, 0.7], [2, 0.35]]);

    // Hidden inactive sheet skipped; unknown sheet reported, not guessed.
    expect(parsed.sheets.find((s) => s.normalized === "carolinas")!.status).toBe("skipped");
    expect(parsed.unmatchedSheets).toEqual(["Brand New Route"]);
    expect(parsed.rows.some((r) => r.route_id === null as any)).toBe(false);
  });
});

describe("sheet name normalization", () => {
  it("matches the workbook's real tab names to map keys", () => {
    expect(normalizeSheetName("Dallas Transfer(Bham)")).toBe("dallas transfer(bham)");
    expect(normalizeSheetName("Bham Transfer  (Dallas)")).toBe("bham transfer (dallas)");
    expect(normalizeSheetName(" North Miss. ")).toBe("north miss.");
  });
});
