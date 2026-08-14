// Locks the CSV contract for the Charlston Office Furniture SFTP delivery.
// The renderer itself lives in the on-prem agent (it is the only place with
// SFTP + SQL Server access), but the format is a partner-facing contract, so
// it gets a test here where the suite actually runs.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS module in the agent workspace, no types.
import { renderCsv, formatCell } from "../../../agent/handlers/csv.js";

describe("website export CSV", () => {
  it("emits header + CRLF rows with a single trailing CRLF", () => {
    const out = renderCsv([{ A: 1, B: 2 }], ["A", "B"], {});
    expect(out).toBe("A,B\r\n1,2\r\n");
  });

  it("keeps column order from the columns array, not object keys", () => {
    const out = renderCsv([{ B: "b", A: "a" }], ["A", "B"], {});
    expect(out).toBe("A,B\r\na,b\r\n");
  });

  it("quotes only when needed and doubles embedded quotes", () => {
    const out = renderCsv([{ A: 'he said "hi", ok', B: "plain" }], ["A", "B"], {});
    expect(out).toBe('A,B\r\n"he said ""hi"", ok",plain\r\n');
  });

  it("renders NULL as an empty field, never the text NULL", () => {
    expect(renderCsv([{ A: null, B: undefined }], ["A", "B"], {})).toBe("A,B\r\n,\r\n");
  });

  it("formats date vs datetime from SQL type metadata", () => {
    const d = new Date(Date.UTC(2026, 7, 14, 13, 5, 9));
    expect(formatCell(d, "date")).toBe("2026-08-14");
    expect(formatCell(d, "datetime")).toBe("2026-08-14 13:05:09");
  });

  it("writes plain decimals and 1/0 booleans", () => {
    expect(formatCell(1234.5678)).toBe("1234.5678");
    expect(formatCell(1000000)).toBe("1000000");
    expect(formatCell(true)).toBe("1");
    expect(formatCell(false)).toBe("0");
  });

  it("can suppress the header row", () => {
    expect(renderCsv([{ A: "x" }], ["A"], { header: false })).toBe("x\r\n");
  });
});
