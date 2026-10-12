import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { normalizeCapacity, parseDateCell, parseTruckCapacityWorkbook } from "../workbook-parse";
import { parseManualWorkbook, validateImportRows } from "../import-contract";
import { aggregate, metricsOf, strictComparison } from "../accuracy";

describe("validated occupancy contract", () => {
  it.each([0, 0.5, 1, "0%", "50%", "100%", { formula: "1/2", result: 0.5 }])(
    "accepts a supported occupancy %j",
    (raw) => {
      expect(normalizeCapacity(raw, "0%").kind).toBe("ok");
    },
  );
  it.each([
    1.4,
    1.8,
    92,
    "140%",
    "180%",
    "1.4",
    -0.1,
    "bad",
    "1,000",
    { formula: "1/0", result: { error: "#DIV/0!" } },
    { formula: "1/2" },
  ])("quarantines %j without guessed scaling or clamping", (raw) => {
    expect(normalizeCapacity(raw, "0%").kind).toBe("rejected");
  });
  it("normalizes explicit percent once and preserves blank versus zero", () => {
    expect(normalizeCapacity("1.4%").value).toBeCloseTo(0.014, 12);
    expect(normalizeCapacity("50%", "0%").value).toBe(0.5);
    for (const raw of [null, "", "  "]) expect(normalizeCapacity(raw).kind).toBe("empty");
    expect(normalizeCapacity(0)).toEqual({ kind: "ok", value: 0 });
  });
  it("validates calendar dates and explicit labels without timezone fallback", () => {
    for (const raw of ["2/30/2026", "2026-02-29", "9/14/2026 - Run 0", "2026-09-14T23:59:59-05:00"])
      expect(parseDateCell(raw)).toBeNull();
    expect(parseDateCell("2024-02-29")?.iso).toBe("2024-02-29");
    expect(parseDateCell(new Date("2026-09-14T00:00:00Z"))?.iso).toBe("2026-09-14");
  });
  it("uses the same departures and raw evidence on both paths; repeats deterministically", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Dallas-Local");
    ws.addRow(["Date", "Capacity"]);
    ws.addRow(["9/14/2026", 0.5]);
    ws.addRow(["9/14/2026 - Run 1", 0]);
    ws.addRow(["9/14/2026", null]);
    ws.addRow(["9/18/2026", { formula: "7/5", result: 1.4 }]);
    ws.getCell("B5").numFmt = "0%";
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const sync = await parseTruckCapacityWorkbook(
      buffer,
      new Map([["dallas-local", { route_id: "DAL-LOCAL", active: true }]]),
    );
    const manual = await parseManualWorkbook(buffer, new Set(["DAL-LOCAL"]));
    expect(manual.rows.map((r) => [r.run_seq, r.capacity_frac])).toEqual([
      [2, 0.5],
      [1, 0],
      [3, null],
    ]);
    expect(manual.rows.map(({ route_code, ...r }) => ({ ...r, route_id: route_code }))).toEqual(
      sync.rows,
    );
    expect(manual.quarantine).toEqual(sync.quarantine);
    expect(manual.quarantine[0]).toMatchObject({
      sheet: "Dallas-Local",
      excel_row: 5,
      capacity: { formula: "7/5", result: 1.4 },
      capacity_format: "0%",
    });
    expect(await parseManualWorkbook(buffer, new Set(["DAL-LOCAL"]))).toEqual(manual);
  });
  it("rejects duplicate identities and invalid values before writing", () => {
    const row = {
      route_id: "r",
      run_date: "2026-09-14",
      run_seq: 1,
      capacity_frac: 0.5,
      vendor_pickup_frac: null,
    };
    expect(() => validateImportRows([row, row])).toThrow("Duplicate departure");
    expect(() => validateImportRows([{ ...row, capacity_frac: 1.4 }])).toThrow(
      "Ambiguous capacity",
    );
    expect(() => validateImportRows([{ ...row, run_date: "2026-02-30" }])).toThrow(
      "Invalid run date",
    );
  });
  it("respects the 1904 workbook epoch and records it with a content hash", async () => {
    const wb = new ExcelJS.Workbook();
    wb.properties.date1904 = true;
    const ws = wb.addWorksheet("Dallas-Local");
    ws.addRow(["Date", "Capacity"]);
    ws.addRow([44727, 0.5]);
    ws.addRow(["44727", 0.5]);
    ws.addRow([{ formula: "44727", result: 44727 }, 0.5]);
    ws.addRow([{ formula: '"44727"', result: "44727" }, 0.5]);
    const parsed = await parseManualWorkbook(
      Buffer.from(await wb.xlsx.writeBuffer()),
      new Set(["DAL-LOCAL"]),
    );
    expect(parsed.rows[0].run_date).toBe("2026-06-16");
    expect(parsed.rows.map((r) => r.run_date)).toEqual(Array(4).fill("2026-06-16"));
    expect(parsed.quarantine).toEqual([]);
    expect(parsed.rows[0].provenance).toMatchObject({ date1904: true, raw_date: 44727 });
    expect(parsed.rows[0].provenance?.workbook_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([false, true])(
    "reserves explicit labels workbook-wide regardless of sheet order (%s)",
    async (reverse) => {
      const wb = new ExcelJS.Workbook();
      const names = reverse ? ["Dallas Local", "Dallas-Local"] : ["Dallas-Local", "Dallas Local"];
      for (const name of names) {
        const ws = wb.addWorksheet(name);
        ws.addRow(["Date", "Capacity"]);
        ws.addRow(name === "Dallas Local" ? ["9/14/2026 - Run 1", 0.7] : ["9/14/2026", 0.5]);
      }
      const parsed = await parseManualWorkbook(
        Buffer.from(await wb.xlsx.writeBuffer()),
        new Set(["DAL-LOCAL"]),
      );
      expect(parsed.quarantine).toEqual([]);
      expect(
        parsed.rows.sort((a, b) => a.run_seq - b.run_seq).map((r) => [r.run_seq, r.capacity_frac]),
      ).toEqual([
        [1, 0.7],
        [2, 0.5],
      ]);
    },
  );
  it("quarantines duplicate explicit labels, invalid dates, and invalid vendor units", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Dallas-Local");
    ws.addRow(["Date", "Capacity", "Vendor Pickup Capacity"]);
    ws.addRow(["9/14/2026 - Run 1", 0.5]);
    ws.addRow(["9/14/2026 - Run 1", 0.4]);
    ws.addRow(["2/30/2026", 0.3]);
    ws.addRow(["9/18/2026", 0.4, "140%"]);
    const parsed = await parseManualWorkbook(
      Buffer.from(await wb.xlsx.writeBuffer()),
      new Set(["DAL-LOCAL"]),
    );
    expect(parsed.quarantine).toHaveLength(3);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe("strict score coverage", () => {
  const log = (made_on: string, served = 0.5) => ({
    made_on,
    served,
    predicted: served,
    method: "baseline",
  });
  const base = {
    runs: 1,
    actual: 0.6,
    missingFromSheet: false,
    cutoffKnown: true,
    cutoffDate: "2026-09-08",
    cutoffAtUtc: "2026-09-08T21:00:00Z",
    runDate: "2026-09-09",
    logs: [log("2026-09-07")],
  };
  it("uses the latest proven earlier date, even if a cutoff-day log exists", () => {
    expect(
      strictComparison({ ...base, logs: [...base.logs, log("2026-09-08", 0.9)] }).picked?.madeOn,
    ).toBe("2026-09-07");
  });
  it.each([
    [{ missingFromSheet: true }, "missing_from_sheet"],
    [{ actual: 1.4 }, "ambiguous_actual"],
    [{ runs: 2 }, "multiple_departures"],
    [{ cutoffKnown: false }, "unknown_cutoff"],
    [{ logs: [] }, "no_forecast"],
    [{ logs: [log("2026-09-08")] }, "date_only_timing_unknown"],
    [{ cutoffDate: "2026-09-06", cutoffAtUtc: "2026-09-06T21:00:00Z" }, "after_cutoff"],
    [{ cutoffAtUtc: null }, "cutoff_timing_unknown"],
    [{ logs: [log("2026-09-09")] }, "no_forecast"],
    [{ logs: [log("2026-09-07", 1.4)] }, "ambiguous_forecast"],
  ])("discloses exclusion %j", (patch, reason) => {
    expect(strictComparison({ ...base, ...patch }).reason).toBe(reason);
  });
  it("does not fabricate rates for no-forecast cohorts; tolerance boundaries are inclusive", () => {
    expect(metricsOf([])).toMatchObject({ n: 0, within10: null, within10N: 0 });
    expect(metricsOf([0.65 - 0.55, -0.1, 0.101])).toMatchObject({ n: 3, within10N: 2 });
    expect(aggregate([]).overall.n).toBe(0);
  });
});
