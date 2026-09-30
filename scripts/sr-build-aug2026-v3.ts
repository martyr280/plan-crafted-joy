// Builds a NEW Sales Reports run for Aug 2026 with the 2026-09-30 corrected definition (month-only exclusions).
// P21 read-only (sql.select). Writes only sales_report_runs / sales_report_rows (new run). No email.
import { runSalesReports } from "../src/lib/sales-reports.server";
const r = await runSalesReports({ year: 2026, month: 8, triggeredBy: null });
console.log(JSON.stringify({ runId: r.runId, status: r.status, reps: r.reps, rows: r.rows,
  unattributed: r.unattributed, parity: r.parityMismatches.length, parityFirst: r.parityMismatches.slice(0, 20),
  errors: r.repStatus.filter((s) => s.status === "error") }, null, 1));
