// Parser for NDI's "Primary Truck Capacity.xlsx" tracker workbook.
//
// Pure-ish: the only I/O is ExcelJS reading an in-memory buffer, so the whole
// thing is unit-testable against a fixture workbook. Columns are located BY
// HEADER TEXT (case-insensitive, fuzzy startsWith), never by position, because
// two layouts exist in the same file and one sheet (OKL) has a typo header.
import ExcelJS from "exceljs";

/* ------------------------------ header matching ----------------------------- */

export type Field =
  | "date"
  | "capacity"
  | "vendor_pickup"
  | "driver"
  | "pallet_count"
  | "returned_pallets"
  | "notes";

/**
 * Ordered candidate table. First match wins, so IGNORED_PREFIXES is consulted
 * before anything else — "Unused Capacity" / "Unused Capcity" (OKL's typo) must
 * never be read as capacity. It is a formula column (1-B) and East TX holds 40
 * instead of 0.4 in it.
 */
export const IGNORED_HEADER_PREFIXES = ["unused cap"];

export const HEADER_FIELD_MAP: Array<{ prefix: string; field: Field }> = [
  { prefix: "date", field: "date" },
  { prefix: "vendor pickup", field: "vendor_pickup" },
  { prefix: "capacity", field: "capacity" },
  { prefix: "driver", field: "driver" },
  { prefix: "pallet count", field: "pallet_count" },
  { prefix: "pallets", field: "pallet_count" },
  { prefix: "returned pallet", field: "returned_pallets" },
  { prefix: "return pallet", field: "returned_pallets" },
  { prefix: "notes", field: "notes" },
  { prefix: "note", field: "notes" },
];

export function normalizeHeader(v: unknown): string {
  return String(cellText(v) ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Header text → field, or null when the column should be ignored. */
export function matchHeader(v: unknown): Field | null {
  const h = normalizeHeader(v);
  if (!h) return null;
  if (IGNORED_HEADER_PREFIXES.some((p) => h.startsWith(p))) return null;
  for (const { prefix, field } of HEADER_FIELD_MAP) {
    if (h.startsWith(prefix)) return field;
  }
  return null;
}

/* -------------------------------- cell values ------------------------------- */

/** Unwrap ExcelJS rich text / formula / hyperlink cell shapes to a scalar. */
function cellScalar(v: any): any {
  if (v == null) return null;
  if (typeof v === "object") {
    if (v instanceof Date) return v;
    if ("result" in v) return cellScalar((v as any).result);
    if ("text" in v) return (v as any).text;
    if ("richText" in v) return (v as any).richText.map((r: any) => r.text).join("");
    if ("error" in v) return null;
  }
  return v;
}

function cellText(v: any): string | null {
  const s = cellScalar(v);
  if (s == null) return null;
  if (s instanceof Date) return s.toISOString();
  const t = String(s).trim();
  return t === "" ? null : t;
}

function toNumber(v: any): number | null {
  const s = cellScalar(v);
  if (s == null || s === "") return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const raw = String(s).trim();
  if (raw === "") return null;
  const n = Number(raw.replace(/[%,\s$]/g, ""));
  if (!Number.isFinite(n)) return null;
  return raw.includes("%") ? n / 100 : n;
}

export function toIntOrNull(v: any): number | null {
  const n = toNumber(v);
  if (n == null) return null;
  return Math.round(n);
}

/* ---------------------------------- dates ----------------------------------- */

/** Excel serial → YYYY-MM-DD, 1899-12-30 epoch, date only, no timezone shift. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + days * 86_400_000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Date cell → { iso, seq } where seq comes from a trailing "- Run N" label.
 * seq is null when the cell carries no explicit run number; the caller then
 * assigns 1, 2, … in sheet order for repeated dates.
 */
export function parseDateCell(v: any): { iso: string; seq: number | null } | null {
  const s = cellScalar(v);
  if (s == null || s === "") return null;

  if (s instanceof Date) {
    // ExcelJS parses date cells as UTC midnight; read UTC parts so no shift.
    const iso = `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}-${String(s.getUTCDate()).padStart(2, "0")}`;
    return { iso, seq: null };
  }
  if (typeof s === "number") {
    const iso = excelSerialToIso(s);
    return iso ? { iso, seq: null } : null;
  }

  const text = String(s).trim();
  if (!text) return null;
  const runMatch = text.match(/[-–—]\s*run\s*(\d+)\s*$/i);
  const seq = runMatch ? Number(runMatch[1]) : null;
  const datePart = (runMatch ? text.slice(0, runMatch.index) : text).trim().replace(/[-–—]\s*$/, "").trim();

  const mdy = datePart.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (mdy) {
    const mm = Number(mdy[1]);
    const dd = Number(mdy[2]);
    let yy = Number(mdy[3]);
    if (yy < 100) yy += yy < 50 ? 2000 : 1900;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return { iso: `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`, seq };
    }
    return null;
  }
  const iso = datePart.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { iso: `${iso[1]}-${iso[2]}-${iso[3]}`, seq };

  // Pure serial-as-text (some sheets store the date as a string).
  if (/^\d{5}(\.\d+)?$/.test(datePart)) {
    const fromSerial = excelSerialToIso(Number(datePart));
    if (fromSerial) return { iso: fromSerial, seq };
  }
  return null;
}

/* -------------------------------- capacity ---------------------------------- */

export type CapacityResult =
  | { kind: "empty"; value: null }
  | { kind: "ok"; value: number }
  | { kind: "rejected"; value: null; raw: number };

/**
 * Capacity is a fraction 0–1. >1 and ≤100 is a percent typed without the sign
 * (divide by 100); >100 is rejected outright and logged. Empty is a no-run
 * marker, not a zero.
 */
export function normalizeCapacity(v: any): CapacityResult {
  const n = toNumber(v);
  if (n == null) return { kind: "empty", value: null };
  if (n < 0) return { kind: "rejected", value: null, raw: n };
  if (n <= 1) return { kind: "ok", value: n };
  if (n <= 100) return { kind: "ok", value: n / 100 };
  return { kind: "rejected", value: null, raw: n };
}

/* --------------------------------- driver ----------------------------------- */

/**
 * Trim, collapse whitespace, Title Case — but an all-caps token of 3 letters or
 * fewer keeps its case, so "DJ" stays "DJ" instead of becoming "Dj".
 */
export function normalizeDriver(v: any): string | null {
  const raw = cellText(v);
  if (raw == null) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const out = collapsed
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => {
          if (!part) return part;
          if (/^[A-Z]{1,3}$/.test(part)) return part; // DJ, JR, TJ
          if (/^[A-Z]{1,3}\.$/.test(part)) return part;
          return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        })
        .join("-"),
    )
    .join(" ");
  return out || null;
}

/* --------------------------------- parsing ---------------------------------- */

export type ParsedRow = {
  route_id: string;
  run_date: string;
  run_seq: number;
  capacity_frac: number | null;
  vendor_pickup_frac: number | null;
  driver: string | null;
  pallet_count: number | null;
  returned_pallets: number | null;
  notes: string | null;
  excel_row: number;
};

export type ParsedSheet = {
  sheet: string;
  normalized: string;
  route_id: string | null;
  status: "ok" | "unmapped" | "skipped" | "no_headers";
  hidden: boolean;
  headers: Partial<Record<Field, number>>;
  rows: number;
  no_run_rows: number;
  skipped_no_date: number;
  rejected_capacity: number;
};

export type ParseResult = {
  sheets: ParsedSheet[];
  rows: ParsedRow[];
  unmatchedSheets: string[];
  warnings: string[];
};

export type SheetMapEntry = { route_id: string | null; active: boolean };

/** sheet_name (already normalized lowercase) → mapping row. */
export type SheetMap = Map<string, SheetMapEntry>;

export function normalizeSheetName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function parseTruckCapacityWorkbook(
  buffer: Buffer | ArrayBuffer,
  sheetMap: SheetMap,
): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const result: ParseResult = { sheets: [], rows: [], unmatchedSheets: [], warnings: [] };

  wb.eachSheet((ws) => {
    const normalized = normalizeSheetName(ws.name);
    const hidden = ws.state === "hidden" || ws.state === "veryHidden";
    const mapped = sheetMap.get(normalized);
    const out: ParsedSheet = {
      sheet: ws.name,
      normalized,
      route_id: mapped?.route_id ?? null,
      status: "ok",
      hidden,
      headers: {},
      rows: 0,
      no_run_rows: 0,
      skipped_no_date: 0,
      rejected_capacity: 0,
    };

    if (!mapped) {
      out.status = "unmapped";
      result.unmatchedSheets.push(ws.name);
      result.sheets.push(out);
      return;
    }
    if (!mapped.active || !mapped.route_id) {
      out.status = "skipped";
      result.sheets.push(out);
      return;
    }

    // Header row is row 1. Later duplicates of the same field are ignored.
    const headerRow = ws.getRow(1);
    const headers: Partial<Record<Field, number>> = {};
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const field = matchHeader(cell.value);
      if (field && headers[field] == null) headers[field] = col;
    });
    out.headers = headers;
    if (headers.date == null) {
      out.status = "no_headers";
      result.warnings.push(`${ws.name}: no "Date" header found in row 1`);
      result.sheets.push(out);
      return;
    }

    const seqUsed = new Map<string, Set<number>>();
    const nextSeq = (iso: string, explicit: number | null): number => {
      let used = seqUsed.get(iso);
      if (!used) { used = new Set(); seqUsed.set(iso, used); }
      if (explicit != null && explicit >= 1) {
        const s = Math.floor(explicit);
        used.add(s);
        return s;
      }
      let s = 1;
      while (used.has(s)) s += 1;
      used.add(s);
      return s;
    };

    const last = ws.actualRowCount > 0 ? ws.rowCount : 0;
    for (let r = 2; r <= last; r++) {
      const row = ws.getRow(r);
      const parsedDate = parseDateCell(row.getCell(headers.date).value);
      if (!parsedDate) {
        // A row with no date is not a run — formula-only tail rows land here.
        if (cellText(row.getCell(headers.date).value) != null) out.skipped_no_date += 1;
        continue;
      }
      const year = Number(parsedDate.iso.slice(0, 4));
      if (!(year >= 2000 && year <= 2100)) {
        out.skipped_no_date += 1;
        continue;
      }

      let capacity: number | null = null;
      if (headers.capacity != null) {
        const cap = normalizeCapacity(row.getCell(headers.capacity).value);
        if (cap.kind === "rejected") {
          out.rejected_capacity += 1;
          result.warnings.push(
            `${ws.name} row ${r}: capacity ${cap.raw} out of range — row rejected`,
          );
          continue;
        }
        capacity = cap.value;
      }
      if (capacity == null) out.no_run_rows += 1;

      let vendor: number | null = null;
      if (headers.vendor_pickup != null) {
        const v = normalizeCapacity(row.getCell(headers.vendor_pickup).value);
        vendor = v.kind === "ok" ? v.value : null;
      }

      result.rows.push({
        route_id: mapped.route_id,
        run_date: parsedDate.iso,
        run_seq: nextSeq(parsedDate.iso, parsedDate.seq),
        capacity_frac: capacity,
        vendor_pickup_frac: vendor,
        driver: headers.driver != null ? normalizeDriver(row.getCell(headers.driver).value) : null,
        pallet_count: headers.pallet_count != null ? toIntOrNull(row.getCell(headers.pallet_count).value) : null,
        returned_pallets: headers.returned_pallets != null ? toIntOrNull(row.getCell(headers.returned_pallets).value) : null,
        notes: headers.notes != null ? cellText(row.getCell(headers.notes).value) : null,
        excel_row: r,
      });
      out.rows += 1;
    }

    result.sheets.push(out);
  });

  return result;
}
