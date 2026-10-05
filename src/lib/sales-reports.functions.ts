import { createServerFn } from "@tanstack/react-start";
import { denyLegacyBranchAccess } from "@/lib/branch-guard";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isValidEmail } from "./sales-report-email";

export const getSalesReportsAccess = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .handler(async ({ context }) => {
    const { resolveAccess } = await import("./sales-reports.access.server");
    return resolveAccess(context.supabase, context.userId);
  });

export const listSalesReportRuns = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("sales_report_runs")
      .select("id, run_at, period_year, period_month, status, rep_count, error, rep_status")
      .order("run_at", { ascending: false })
      .limit(60);
    if (error) throw new Error(error.message);
    return { runs: data ?? [] };
  });

export const getSalesReportOverview = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((data: { runId?: string | null }) => data ?? {})
  .handler(async ({ data, context }) => {
    const { loadOverview } = await import("./sales-reports.access.server");
    return loadOverview(context.supabase, context.userId, data.runId ?? null);
  });

export const getSalesRepDetail = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((data: { runId?: string | null; repCode?: string | null }) => data ?? {})
  .handler(async ({ data, context }) => {
    const { loadRepDetail } = await import("./sales-reports.access.server");
    return loadRepDetail(context.supabase, context.userId, data.runId ?? null, data.repCode ?? null);
  });

export const runSalesReportsNow = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { runSalesReports } = await import("./sales-reports.server");
    return runSalesReports({ triggeredBy: context.userId });
  });

export const exportSalesRepWorkbook = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((data: { runId: string; repCode?: string | null }) => data)
  .handler(async ({ data, context }) => {
    const { resolveAccess } = await import("./sales-reports.access.server");
    const access = await resolveAccess(context.supabase, context.userId);
    const repCode = access.canManage ? (data.repCode ?? access.repCode) : access.repCode;
    if (!repCode) throw new Error("No rep selected");
    const { buildRepWorkbook } = await import("./sales-reports.server");
    const { filename, buffer } = await buildRepWorkbook(context.supabase, data.runId, repCode);
    return {
      filename,
      contentBase64: buffer.toString("base64"),
    };
  });

export const runSalesReportForRep = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((data: { repCode: string; year: number; month: number; persist: boolean }) => {
    if (!data || typeof data.repCode !== "string" || !data.repCode.trim()) throw new Error("repCode is required");
    const year = Number(data.year);
    const month = Number(data.month);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error("year must be 2020-2100");
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("month must be 1-12");
    return { repCode: data.repCode.trim(), year, month, persist: !!data.persist };
  })
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { runSalesReportForRep: run } = await import("./sales-reports.server");
    return run({ ...data, triggeredBy: context.userId });
  });

export const getSalesReportDrilldown = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((data: { runId?: string | null; kind: string }) => {
    const kinds = ["ytd", "month", "at_risk", "win_back"] as const;
    if (!data || !kinds.includes(data.kind as any)) throw new Error("kind must be ytd | month | at_risk | win_back");
    return { runId: data.runId ?? null, kind: data.kind as (typeof kinds)[number] };
  })
  .handler(async ({ data, context }) => {
    const { resolveAccess } = await import("./sales-reports.access.server");
    const access = await resolveAccess(context.supabase, context.userId);
    if (!access.canManage) throw new Response("Forbidden", { status: 403 });
    const { loadDrilldown } = await import("./sales-reports.access.server");
    return loadDrilldown(context.supabase, data.runId, data.kind);
  });

// ---------- Per-rep report emails (admin sends; admin + sales_manager read) ----------

async function requireManage(context: any) {
  const { resolveAccess } = await import("./sales-reports.access.server");
  const a = await resolveAccess(context.supabase, context.userId);
  if (!a.canManage) throw new Error("Forbidden");
}

export const listRepContacts = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .handler(async ({ context }) => {
    await requireManage(context);
    const { data, error } = await context.supabase
      .from("sales_rep_contacts")
      .select("rep_code, rep_name, email, cc_emails, send_enabled, notes, updated_at")
      .order("rep_name").limit(5000);
    if (error) throw new Error(error.message);
    return { contacts: data ?? [] };
  });

export const saveRepContact = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((d: { rep_code: string; email: string | null; cc_emails: string[]; send_enabled: boolean; notes: string | null }) => {
    if (!d?.rep_code) throw new Error("rep_code is required");
    const email = d.email?.trim() || null;
    if (email && !isValidEmail(email)) throw new Error(`Invalid email: ${email}`);
    const cc = (d.cc_emails ?? []).map((e) => e.trim()).filter(Boolean);
    for (const e of cc) if (!isValidEmail(e)) throw new Error(`Invalid CC email: ${e}`);
    return { rep_code: d.rep_code, email, cc_emails: cc, send_enabled: !!d.send_enabled, notes: d.notes?.trim() || null };
  })
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("sales_rep_contacts")
      .update({ email: data.email, cc_emails: data.cc_emails, send_enabled: data.send_enabled, notes: data.notes, updated_by: context.userId })
      .eq("rep_code", data.rep_code);
    if (error) throw new Error(error.message);
    return { ok: true };
  });


export const getEmailSendList = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((d: { runId?: string | null }) => d ?? {})
  .handler(async ({ data, context }) => {
    await requireManage(context);
    const { loadSendContext, repListFromContext } = await import("./sales-report-email.server");
    const ctx = await loadSendContext(context.supabase, data.runId ?? null);
    return { run: ctx.run, reps: repListFromContext(ctx) };
  });

type SendInput = { runId: string; repCodes: string[]; sendAgain: boolean; testMode: boolean };
const validateSend = (d: SendInput) => {
  if (!d || typeof d.runId !== "string" || !Array.isArray(d.repCodes)) throw new Error("runId and repCodes are required");
  return { runId: d.runId, repCodes: d.repCodes.map(String), sendAgain: !!d.sendAgain, testMode: !!d.testMode };
};

export const previewSalesReportEmails = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator(validateSend)
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { loadSendContext, previewFromContext } = await import("./sales-report-email.server");
    const ctx = await loadSendContext(context.supabase, data.runId);
    const sessionEmail = (context.claims as any)?.email ?? null;
    return previewFromContext(ctx, { selected: data.repCodes, sendAgain: data.sendAgain, testMode: data.testMode, sessionEmail });
  });

export const sendSalesReportEmails = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((d: SendInput & { expectedRows: Record<string, number> }) => ({
    ...validateSend(d),
    expectedRows: Object.fromEntries(Object.entries(d?.expectedRows ?? {}).map(([k, v]) => [k, Number(v)])),
  }))
  .handler(async ({ data, context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { loadSendContext, executeSends, dbRowFetcher } = await import("./sales-report-email.server");
    const { sendNelsonEmailWithAttachment } = await import("./email/nelson-resend.server");
    const ctx = await loadSendContext(context.supabase, data.runId);
    const results = await executeSends({
      ctx, selected: data.repCodes, expectedRows: data.expectedRows, sendAgain: data.sendAgain,
      testMode: data.testMode, sessionEmail: (context.claims as any)?.email ?? null, userId: context.userId,
      fetchRows: dbRowFetcher(context.supabase),
      sender: sendNelsonEmailWithAttachment,
      log: async (row) => {
        const { error } = await context.supabase.from("sales_report_sends").insert(row as any);
        if (error) console.error("sales_report_sends insert failed", error.message);
      },
    });
    return { results };
  });

/**
 * Admin: re-match rep emails from P21 contacts BY NAME (read-only on P21).
 * Fills only rows whose email is empty; never overwrites an admin-typed email.
 */
export const rematchRepEmailsFromP21 = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { fetchP21Contacts } = await import("./sales-reports.server");
    const { matchAllReps, REP_EMAIL_NOTE } = await import("./rep-contact-match");
    const { data: rows, error } = await context.supabase.from("sales_rep_contacts").select("rep_code, rep_name, email").limit(5000);
    if (error) throw new Error(error.message);
    const contacts = await fetchP21Contacts(90_000);
    const results = matchAllReps((rows ?? []) as { rep_code: string; rep_name: string | null }[], contacts);
    let filled = 0;
    const out: { rep_code: string; result: string }[] = [];
    for (const r of results) {
      const cur = (rows ?? []).find((x: any) => x.rep_code === r.rep_code) as any;
      if (cur?.email?.trim()) { out.push({ rep_code: r.rep_code, result: "kept existing email" }); continue; }
      if (r.m.kind !== "match" || r.withheld) { out.push({ rep_code: r.rep_code, result: r.withheld ?? r.m.kind }); continue; }
      const { data: upd, error: ue } = await context.supabase.from("sales_rep_contacts")
        .update({ email: r.m.contact.email!.trim(), notes: REP_EMAIL_NOTE(r.m.contact.id), updated_by: context.userId })
        .eq("rep_code", r.rep_code).is("email", null).select("rep_code");
      if (ue) throw new Error(ue.message);
      if (upd?.length) { filled++; out.push({ rep_code: r.rep_code, result: `filled ${r.m.contact.email}` }); }
    }
    return { filled, results: out };
  });
