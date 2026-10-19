import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSummaryExclusionRows, uniqueSheetName, type SummaryLine } from "../spiff/workbook-summary";
import { createInFlightGuard, generateDialogCopy, inclusiveRangeLabel, latestRunForQuarter } from "../spiff/generate-dialog";

const Q3_RULES = [
  { code: "quarter_basis_invoice_date", label: "Quarter = invoice date" },
  { code: "invoiced_only", label: "Invoiced lines only" },
  { code: "no_returns_credits", label: "No returns/credits" },
  { code: "no_quotes", label: "No quotes" },
  { code: "no_cancelled", label: "No cancelled" },
  { code: "no_samples", label: "No samples" },
  { code: "no_catalogs", label: "No catalogs" },
];
const make = (n: number, l: SummaryLine) => Array.from({ length: n }, () => ({ ...l }));
const rowSum = (rows: ReturnType<typeof buildSummaryExclusionRows>) =>
  rows.filter((r) => r.key !== "total" && typeof r.value === "number").reduce((s, r) => s + (r.value as number), 0);
const total = (rows: ReturnType<typeof buildSummaryExclusionRows>) => rows.find((r) => r.key === "total")!;

describe("SPIFF workbook Summary reconciliation", () => {
  it("Q3-shaped run: exclusion rows sum to 322 and equal Total excluded", () => {
    const lines = [
      ...make(1228, { included: true }),
      ...make(144, { included: false, exclusion_reason: "not_invoiced" }),
      ...make(77, { included: false, exclusion_reason: "return_credit" }),
      ...make(101, { included: false, exclusion_reason: "out_of_scope" }),
    ];
    expect(lines.length).toBe(1550);
    const rows = buildSummaryExclusionRows(Q3_RULES, lines);
    expect(rowSum(rows)).toBe(322);
    expect(total(rows)).toMatchObject({ label: "Total excluded", value: 322, bold: true });
    expect(rows.find((r) => r.key === "out_of_scope")).toMatchObject({ label: "Outside the program's product scope", value: 101 });
  });
  it("3 null/empty-reason excluded lines show an 'Excluded (no reason recorded)' row of 3", () => {
    const lines = [...make(5, { included: true }), { included: false, exclusion_reason: null }, { included: false }, { included: false, exclusion_reason: "  " }];
    const rows = buildSummaryExclusionRows(Q3_RULES, lines);
    expect(rows.find((r) => r.label === "Excluded (no reason recorded)")?.value).toBe(3);
    expect(total(rows).value).toBe(3);
  });
  it("manual exclusions counted once; unknown codes labelled 'Excluded: <code>'", () => {
    const lines = [...make(4, { included: false, exclusion_reason: "manual" }), { included: false, exclusion_reason: "weird" }, { included: true }];
    const rows = buildSummaryExclusionRows(Q3_RULES, lines);
    expect(rows.filter((r) => r.key === "manual")).toEqual([{ label: "Manually excluded", value: 4, key: "manual" }]);
    expect(rows.find((r) => r.key === "weird")?.label).toBe("Excluded: weird");
    expect(rowSum(rows)).toBe(5);
    expect(total(rows).value).toBe(5);
  });
  it("a reason already shown by a rule is never added again", () => {
    const rows = buildSummaryExclusionRows([...Q3_RULES, { code: "invoiced_only", label: "dup" }], make(2, { included: false, exclusion_reason: "not_invoiced" }));
    expect(rowSum(rows)).toBe(2);
    expect(rows.filter((r) => r.key === "not_invoiced").length).toBe(2); // second shows 0
  });
});

describe("SPIFF unique sheet names", () => {
  it("two 36-char ids sharing the first 31 chars get distinct ≤31-char names", () => {
    const taken = new Set(["summary", "empty"]);
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ01234-AAAA";
    const b = "ABCDEFGHIJKLMNOPQRSTUVWXYZ01234-BBBB";
    const na = uniqueSheetName(a, taken), nb = uniqueSheetName(b, taken), nc = uniqueSheetName(a, taken);
    expect(na).toBe(a.slice(0, 31));
    expect(nb).toBe(a.slice(0, 29) + "~2");
    expect(nc).toBe(a.slice(0, 29) + "~3");
    for (const n of [na, nb, nc]) expect(n.length).toBeLessThanOrEqual(31);
  });
  it("strips apostrophes, sanitizes, avoids empty/History/Summary", () => {
    const taken = new Set(["summary"]);
    expect(uniqueSheetName("'C/1'", taken)).toBe("C_1");
    expect(uniqueSheetName("''", taken)).toBe("Sheet");
    expect(uniqueSheetName("History", taken).toLowerCase()).not.toBe("history");
    expect(uniqueSheetName("Summary", taken)).toBe("Summary~2");
  });
  it("workbook.server uses the helpers", () => {
    const src = readFileSync("src/lib/spiff/workbook.server.ts", "utf8");
    expect(src).toContain("uniqueSheetName(String(program.customer_id), takenSheetNames)");
    expect(src).toContain("buildSummaryExclusionRows(rules, lines)");
  });
});

describe("SPIFF Generate dialog copy", () => {
  const runs = [
    { id: "a", quarter_label: "Q3-2026", status: "approved", created_at: "2026-10-01T00:00:00Z" },
    { id: "b", quarter_label: "Q3-2026", status: "draft", created_at: "2026-10-10T00:00:00Z" },
    { id: "c", quarter_label: "Q2-2026", status: "in_review", created_at: "2026-11-01T00:00:00Z" },
  ];
  const lines = [
    { included: false, exclusion_reason: "manual" },
    { included: false, exclusion_reason: "manual" },
    { included: true, flags: { manual_include: true } },
    { included: true, rep_parse_confidence: "manual" },
  ];
  it("latest run by created_at", () => {
    expect(latestRunForQuarter(runs, "Q3-2026")?.id).toBe("b");
  });
  it("draft: Regenerate copy with counts when the draft is loaded", () => {
    const d = generateDialogCopy({ runs, quarterLabel: "Q3-2026", currentRunId: "b", lines, rangeLabel: "Jul 1 – Sep 30, 2026" });
    expect(d.mode).toBe("draft");
    expect(d.title).toBe("Regenerate Q3-2026 draft?");
    expect(d.body).toContain("2 manual exclusions, 1 manual re-includes and 1 rep reassignments");
  });
  it("draft: counts omitted when another run is loaded", () => {
    const d = generateDialogCopy({ runs, quarterLabel: "Q3-2026", currentRunId: "a", lines, rangeLabel: "x" });
    expect(d.body).not.toMatch(/\d manual exclusions/);
  });
  it("non-draft: new run copy, in_review warning", () => {
    const d = generateDialogCopy({ runs, quarterLabel: "Q2-2026", currentRunId: null, lines: [], rangeLabel: "x" });
    expect(d.mode).toBe("new_run");
    expect(d.title).toBe("Create a new Q2-2026 run?");
    expect(d.body).toContain("The in_review run is kept unchanged; a new draft run is created");
    expect(d.warning).toMatch(/in review/);
    const ap = generateDialogCopy({ runs: [runs[0]], quarterLabel: "Q3-2026", currentRunId: null, lines: [], rangeLabel: "x" });
    expect(ap.warning).toBeNull();
  });
  it("none: Generate copy", () => {
    const d = generateDialogCopy({ runs, quarterLabel: "Q4-2026", currentRunId: null, lines: [], rangeLabel: "Oct 1 – Dec 31, 2026" });
    expect(d).toMatchObject({ mode: "none", title: "Generate Q4-2026?", action: "Generate" });
  });
  it("inclusive end date label", () => {
    expect(inclusiveRangeLabel("2026-07-01", "2026-10-01")).toBe("Jul 1 – Sep 30, 2026");
    expect(inclusiveRangeLabel("2026-10-01", "2027-01-01")).toBe("Oct 1 – Dec 31, 2026");
  });
});

describe("in-flight guard", () => {
  it("second call while running is a no-op; resets after finish and after throw", async () => {
    const g = createInFlightGuard();
    let calls = 0;
    let release!: () => void;
    const p1 = g.run(() => { calls++; return new Promise<void>((r) => (release = r)); });
    expect(await g.run(async () => { calls++; })).toBeNull();
    release(); await p1;
    await expect(g.run(async () => { calls++; throw new Error("x"); })).rejects.toThrow("x");
    await g.run(async () => { calls++; });
    expect(calls).toBe(3);
  });
  it("SPIFF screen wires the guard, trigger, load-error card and toast", () => {
    const src = readFileSync("src/routes/_app.spiff.tsx", "utf8");
    expect(src).toContain("useRef(createInFlightGuard()).current");
    expect(src).toContain("await generateGuard.run(async () => {");
    expect(src).not.toContain("generatingRef");
    expect(src).toMatch(/<AlertDialogTrigger asChild>\s*<Button disabled=\{generating\}>/);
    expect(src).not.toContain("onClick={() => setConfirmGenerateOpen(true)}");
    expect(src).toContain("Couldn't load the full run. Nothing is shown so you don't act on partial data.");
    expect(src).toContain("duration: Infinity");
    expect(src).toContain("if (currentRunIdRef.current !== runId) return;");
  });
});
