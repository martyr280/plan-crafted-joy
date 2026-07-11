// SPIFF workbook builder — produces an .xlsx that matches the manual
// "Q1 SPIFF 2026.xlsx" format AP is used to. One worksheet per customer.

import ExcelJS from "exceljs";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Program = {
  id: string;
  customer_id: string;
  customer_name: string;
  rep_org: string;
  rate: number;
  payout_mode: "per_writing_rep" | "single_check";
  payee_name: string | null;
  min_check_amount: number;
};

type Line = {
  program_id: string;
  customer_id: string;
  order_date: string | null;
  first_invoice_date: string | null;
  last_invoice_date: string | null;
  invoice_date: string | null;
  order_no: string | null;
  po_no: string | null;
  item_id: string | null;
  item_desc: string | null;
  qty_ordered: number | null;
  unit_price: number | null;
  extended_price: number | null;
  spiff_amount: number;
  writing_rep: string | null;
  included: boolean;
  flags: any;
};

type Check = {
  program_id: string;
  customer_id: string;
  payee: string;
  amount: number;
  line_count: number;
  below_minimum: boolean;
};

type RunRow = { id: string; quarter_label: string; totals: any };

const HEADERS = [
  "ORDER DATE",
  "INVOICE DATE",
  "ORDER NUMBER",
  "PO NUMBER",
  "ITEM ID",
  "ITEM DESCRIPTION",
  "QTY ORDERED",
  "UNIT PRICE",
  "EXTENDED PRICE",
  "SPIFF",
];

// One entry per header column (10 columns).
const COL_WIDTHS = [13, 13, 13, 22, 14, 38, 11, 12, 14, 12];

function quarterOrdinal(label: string): { ordinal: string; year: string } {
  // "Q2-2026" → { ordinal: "2nd", year: "2026" }
  const m = /^Q([1-4])-(\d{4})$/.exec(label.trim());
  if (!m) return { ordinal: "?", year: label };
  const map: Record<string, string> = { "1": "1st", "2": "2nd", "3": "3rd", "4": "4th" };
  return { ordinal: map[m[1]], year: m[2] };
}

export function formatQuarterTitle(customerName: string, repOrg: string, quarterLabel: string): string {
  const { ordinal, year } = quarterOrdinal(quarterLabel);
  return `${customerName.toUpperCase()} ${ordinal} QTR ${year} — ${repOrg.toUpperCase()}`;
}

function addCustomerSheet(
  wb: ExcelJS.Workbook,
  program: Program,
  lines: Line[],
  checks: Check[],
  quarterLabel: string
) {
  // Sheet name = customer_id (Excel max 31 chars, no special chars)
  const sheetName = String(program.customer_id).replace(/[\\\/\?\*\[\]:]/g, "_").slice(0, 31);
  const ws = wb.addWorksheet(sheetName);

  // Column widths
  for (let i = 0; i < COL_WIDTHS.length; i++) {
    ws.getColumn(i + 1).width = COL_WIDTHS[i];
  }
  ws.getColumn(11).width = 4; // K spacer
  ws.getColumn(12).width = 36; // L payee
  ws.getColumn(13).width = 14; // M amount

  // Row 1 — title, merged A1:J1 (10 data columns now)
  ws.mergeCells("A1:J1");
  const title = ws.getCell("A1");
  title.value = formatQuarterTitle(program.customer_name, program.rep_org, quarterLabel);
  title.font = { bold: true, size: 14 };
  title.alignment = { vertical: "middle", horizontal: "left" };
  ws.getRow(1).height = 22;

  // Row 2 — headers
  HEADERS.forEach((h, i) => {
    const c = ws.getCell(2, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.alignment = { vertical: "middle" };
  });

  // Group included lines by writing_rep
  const included = lines.filter((l) => l.included);
  const groups = new Map<string, Line[]>();
  for (const l of included) {
    const key = l.writing_rep ?? "(Unassigned)";
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "(Unassigned)") return 1;
    if (b === "(Unassigned)") return -1;
    return a.localeCompare(b);
  });

  let row = 3;
  for (const key of sortedKeys) {
    const rows = (groups.get(key) ?? []).slice().sort((a, b) => {
      const ad = a.order_date ? new Date(a.order_date).getTime() : 0;
      const bd = b.order_date ? new Date(b.order_date).getTime() : 0;
      return ad - bd;
    });
    const firstRow = row;
    for (const l of rows) {
      const r = ws.getRow(row);
      const orderDate = l.order_date ? new Date(l.order_date) : null;
      const invDate = l.last_invoice_date
        ? new Date(l.last_invoice_date)
        : l.invoice_date
        ? new Date(l.invoice_date)
        : null;
      r.getCell(1).value = orderDate;
      if (orderDate) r.getCell(1).numFmt = "m/d/yyyy";
      r.getCell(2).value = invDate;
      if (invDate) r.getCell(2).numFmt = "m/d/yyyy";
      r.getCell(3).value = l.order_no ?? null;
      r.getCell(4).value = l.po_no ?? null;
      r.getCell(5).value = l.item_id ?? null;
      r.getCell(6).value = l.item_desc ?? null;
      r.getCell(7).value = Number(l.qty_ordered ?? 0);
      r.getCell(8).value = Number(l.unit_price ?? 0);
      r.getCell(8).numFmt = "#,##0.00;(#,##0.00)";
      r.getCell(9).value = Number(l.extended_price ?? 0);
      r.getCell(9).numFmt = "#,##0.00;(#,##0.00)";
      // SPIFF as a live Excel formula so AP can audit it.
      r.getCell(10).value = { formula: `I${row}*${program.rate}` } as any;
      r.getCell(10).numFmt = "#,##0.00;(#,##0.00)";
      row++;
    }
    const lastRow = row - 1;
    // Total row
    const tr = ws.getRow(row);
    tr.getCell(9).value = `TOTAL — ${key}`;
    tr.getCell(9).font = { bold: true };
    tr.getCell(9).alignment = { horizontal: "right" };
    tr.getCell(10).value = { formula: `SUM(J${firstRow}:J${lastRow})` } as any;
    tr.getCell(10).numFmt = "#,##0.00;(#,##0.00)";
    tr.getCell(10).font = { bold: true };
    row++;
    // blank separator
    row++;
  }

  if (included.length === 0) {
    ws.getCell(3, 1).value = "(No included lines)";
    ws.getCell(3, 1).font = { italic: true, color: { argb: "FF888888" } };
    row = 4;
  }

  // Right-side payee block — starts at L2 (M is amount)
  const payeeCol = 12; // L
  const amtCol = 13; // M
  const header = ws.getCell(2, payeeCol);
  header.value = "Make Checks Payable to:";
  header.font = { bold: true };
  ws.mergeCells(2, payeeCol, 2, amtCol);

  let pr = 3;
  const programChecks = checks.filter((c) => c.program_id === program.id);
  for (const c of programChecks) {
    const r = ws.getRow(pr);
    let label = c.payee;
    if (c.below_minimum) label = `${label} — UNDER $${Number(program.min_check_amount)}, NO CHECK`;
    r.getCell(payeeCol).value = label;
    r.getCell(amtCol).value = Number(c.amount ?? 0);
    r.getCell(amtCol).numFmt = "#,##0.00;(#,##0.00)";
    if (c.below_minimum) {
      r.getCell(payeeCol).font = { italic: true, color: { argb: "FF888888" } };
      r.getCell(amtCol).font = { italic: true, color: { argb: "FF888888" } };
    }
    pr++;
  }

  // For 11460 (single_check w/ rep breakdown): list per-rep subtotals under the owner line.
  if (program.payout_mode === "single_check" && program.customer_id === "11460") {
    const sub = new Map<string, number>();
    for (const l of included) {
      const k = l.writing_rep ?? "(Unassigned)";
      sub.set(k, (sub.get(k) ?? 0) + Number(l.spiff_amount || 0));
    }
    pr++;
    ws.getCell(pr, payeeCol).value = "Rep breakdown:";
    ws.getCell(pr, payeeCol).font = { italic: true, bold: true };
    pr++;
    for (const [rep, amt] of Array.from(sub.entries()).sort()) {
      ws.getCell(pr, payeeCol).value = rep;
      ws.getCell(pr, payeeCol).font = { italic: true };
      ws.getCell(pr, amtCol).value = Number(amt);
      ws.getCell(pr, amtCol).numFmt = "#,##0.00;(#,##0.00)";
      ws.getCell(pr, amtCol).font = { italic: true };
      pr++;
    }
  }

  // Freeze rows 1-2
  ws.views = [{ state: "frozen", ySplit: 2 }];
}

async function fetchRunBundle(runId: string, customerIds?: string[]) {
  const { data: run } = await supabaseAdmin
    .from("spiff_runs")
    .select("id, quarter_label, totals")
    .eq("id", runId)
    .single();
  if (!run) throw new Error("Run not found");


  let progQ = supabaseAdmin.from("spiff_programs").select("*");
  if (customerIds && customerIds.length) progQ = progQ.in("customer_id", customerIds);
  const { data: programs } = await progQ.order("customer_name");

  let lineQ = supabaseAdmin
    .from("spiff_run_lines")
    .select("*")
    .eq("run_id", runId)
    .limit(50000);
  if (customerIds && customerIds.length) lineQ = lineQ.in("customer_id", customerIds);
  const { data: lines } = await lineQ;

  let checkQ = supabaseAdmin
    .from("spiff_checks")
    .select("*")
    .eq("run_id", runId)
    .limit(5000);
  if (customerIds && customerIds.length) checkQ = checkQ.in("customer_id", customerIds);
  const { data: checks } = await checkQ;

  return {
    run: run as RunRow,
    programs: (programs ?? []) as Program[],
    lines: (lines ?? []) as Line[],
    checks: (checks ?? []) as Check[],
  };
}

function addSummarySheet(wb: ExcelJS.Workbook, run: RunRow) {
  const ws = wb.addWorksheet("Summary");
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 70;
  ws.getColumn(3).width = 14;

  ws.mergeCells("A1:C1");
  const title = ws.getCell("A1");
  title.value = `SPIFF ${run.quarter_label} — Data selection rules applied`;
  title.font = { bold: true, size: 14 };

  const totals = run.totals ?? {};
  const rules: Array<{ code: string; label: string; where?: string }> = totals.exclusion_rules ?? [];
  const counts: Record<string, number> = totals.exclusion_counts ?? {};

  ws.getRow(3).values = ["#", "Rule", "Excluded"];
  ws.getRow(3).font = { bold: true };

  let r = 4;
  rules.forEach((rule, i) => {
    const key =
      rule.code === "invoiced_only" ? "not_invoiced"
      : rule.code === "no_quotes" ? "quote"
      : rule.code === "no_cancelled" ? "cancelled"
      : rule.code === "no_samples" ? "sample"
      : rule.code === "no_catalogs" ? "catalog"
      : rule.code;
    const val = rule.code === "quarter_basis_invoice_date" ? "n/a (basis rule)" : Number(counts[key] ?? 0);
    ws.getRow(r).values = [i + 1, rule.label, val];
    r++;
  });

  r++;
  ws.getCell(`A${r}`).value = "Notes:";
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  ws.getCell(`B${r}`).value = "Quarter assignment = INVOICE DATE (invoice_hdr.invoice_date). A line pays in the quarter its invoice_date falls in, regardless of when it was ordered. Partial invoicing across quarters: each quarter pays only its own in-window invoiced portion.";
  ws.getCell(`B${r}`).alignment = { wrapText: true };
  r++;
  ws.getCell(`B${r}`).value = "Quotes are hard-excluded at the SQL layer (oe_hdr.projected_order = 'N'), so no per-line rows exist for them.";
  ws.getCell(`B${r}`).alignment = { wrapText: true };
  r++;
  ws.getCell(`B${r}`).value = "Sample/catalog detection: keyword match (SAMPLE / CATALOG) on item_id + description, standalone CAT token in item_id (e.g. 'ND 2026 CAT D'), plus a confirmed catalog SKU deny list. Edit src/lib/spiff/constants.ts to refine.";
  ws.getCell(`B${r}`).alignment = { wrapText: true };
  r++;
  ws.getCell(`B${r}`).value = "SPIFF basis is invoiced amount (not ordered), summed only over invoices whose invoice_date falls inside the quarter window.";
  ws.getCell(`B${r}`).alignment = { wrapText: true };

  ws.views = [{ state: "frozen", ySplit: 3 }];
}

export async function buildSpiffWorkbook(

  runId: string,
  opts?: { customerIds?: string[] }
): Promise<{ filename: string; buffer: Buffer; quarterLabel: string }> {
  const { run, programs, lines, checks } = await fetchRunBundle(runId, opts?.customerIds);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Nelson AI — SPIFF";
  wb.created = new Date();

  // Summary/rules sheet first so AP + reps see exactly which selection
  // rules were applied to this run (client requirement).
  addSummarySheet(wb, run);

  // Order sheets by customer_name for consistency with the manual workbook
  for (const p of programs) {
    const pl = lines.filter((l) => l.program_id === p.id);
    if (pl.length === 0) continue; // skip customers with zero lines
    addCustomerSheet(wb, p, pl, checks, run.quarter_label);
  }


  // If nothing was added, leave one placeholder sheet so the file is valid.
  if (wb.worksheets.length === 0) {
    const ws = wb.addWorksheet("Empty");
    ws.getCell("A1").value = `No lines for ${run.quarter_label}`;
  }

  const buf = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(buf as ArrayBuffer);
  const filename = `SPIFF-${run.quarter_label}.xlsx`;
  return { filename, buffer, quarterLabel: run.quarter_label };
}

export async function buildRepSheetWorkbook(
  runId: string,
  customerIds: string[]
): Promise<{ filename: string; buffer: Buffer; quarterLabel: string }> {
  const r = await buildSpiffWorkbook(runId, { customerIds });
  return r;
}
