import {
  parseTruckCapacityWorkbook,
  normalizeSheetName,
  type ParsedRow,
  type SheetMap,
} from "./workbook-parse";
import { SHEET_TO_ROUTE_CODE } from "./sheet-map";

export type ImportRow = Omit<ParsedRow, "route_id"> & { route_code: string };

/** Both upload paths use exactly the same cell and departure contract. */
export async function parseManualWorkbook(buffer: Buffer, validCodes: Set<string>) {
  const map: SheetMap = new Map(
    Object.entries(SHEET_TO_ROUTE_CODE).map(([sheet, code]) => [
      normalizeSheetName(sheet),
      {
        route_id: code === "__SKIP__" ? null : code,
        active: code !== "__SKIP__" && validCodes.has(code),
      },
    ]),
  );
  const parsed = await parseTruckCapacityWorkbook(buffer, map);
  return {
    sheets: parsed.sheets.map((s) => ({
      sheet: s.sheet,
      route_code: s.route_id,
      status: s.status,
      ok: s.rows,
      skipped_bad_date: s.skipped_no_date,
      skipped_no_capacity: s.no_run_rows,
      skipped_old_year: 0,
      quarantined: s.rejected_capacity,
    })),
    rows: parsed.rows.map(({ route_id, ...row }) => ({ ...row, route_code: route_id })),
    totalOk: parsed.rows.length,
    quarantine: parsed.quarantine,
    warnings: parsed.warnings,
  };
}

/** Validate the entire payload before any writes; duplicate identities never win silently. */
export function validateImportRows(
  rows: Array<
    Pick<ParsedRow, "route_id" | "run_date" | "run_seq" | "capacity_frac" | "vendor_pickup_frac">
  >,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    const date = new Date(`${row.run_date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.run_date) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== row.run_date
    )
      throw new Error("Invalid run date");
    if (!Number.isInteger(row.run_seq) || row.run_seq < 1)
      throw new Error("Invalid departure sequence");
    for (const value of [row.capacity_frac, row.vendor_pickup_frac]) {
      if (value != null && (!Number.isFinite(value) || value < 0 || value > 1))
        throw new Error("Ambiguous capacity: occupancy must be 0–100%");
    }
    const key = `${row.route_id}|${row.run_date}|${row.run_seq}`;
    if (seen.has(key)) throw new Error(`Duplicate departure ${key}; review workbook labels`);
    seen.add(key);
  }
}
