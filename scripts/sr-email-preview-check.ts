// READ-ONLY: builds the preview (all reps) for run 6a6d2355 and generates, without sending,
// attachments for 5333 and 4157. No email, no writes.
import { supabaseAdmin } from "../src/integrations/supabase/client.server";
import { loadSendContext, previewFromContext, buildVerifiedAttachment, dbRowFetcher } from "../src/lib/sales-report-email.server";
import { SKIP_LABEL } from "../src/lib/sales-report-email";
import ExcelJS from "exceljs";
const ctx = await loadSendContext(supabaseAdmin, "6a6d2355-dd34-4371-ae04-37d0a4d038b1");
const p = previewFromContext(ctx, { selected: ctx.reps.map((r) => r.rep_code), sendAgain: false, testMode: false, sessionEmail: null });
console.log(`WILL SEND (${p.send.length})`);
for (const s of p.send) console.log(`${s.rep_code} | ${s.rep_name} | ${s.to}${s.cc.length ? " cc " + s.cc.join(",") : ""} | ${s.attachment} | ${s.rows}`);
console.log(`SKIPPED (${p.skipped.length})`);
for (const s of p.skipped) console.log(`${s.rep_code} | ${s.rep_name} | ${SKIP_LABEL[s.reason]}`);
for (const code of ["5333", "4157"]) {
  const exp = ctx.reps.find((r) => r.rep_code === code)!.rows;
  const a = await buildVerifiedAttachment(dbRowFetcher(supabaseAdmin), ctx.run.id, code, ctx.run.year, ctx.run.month, exp);
  if (!a.ok) { console.log(code, "FAILED", a.error); continue; }
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(a.buffer as any);
  const dataRows = wb.worksheets[0]!.rowCount - 4; // title, blank, header, total
  const codes = new Set(a.rows.map((r) => r.rep_code));
  console.log(`${code}: file ${a.filename}, ${a.buffer.length} bytes, rows fetched ${a.rows.length}, preview ${exp}, xlsx data rows ${dataRows}, distinct rep_code ${[...codes].join(",")}, all match ${a.rows.every((r) => r.rep_code === code)}`);
}
