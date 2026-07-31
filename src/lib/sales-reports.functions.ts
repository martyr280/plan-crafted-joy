import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getSalesReportsAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { resolveAccess } = await import("./sales-reports.access.server");
    return resolveAccess(context.supabase, context.userId);
  });

export const listSalesReportRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { runId?: string | null }) => data ?? {})
  .handler(async ({ data, context }) => {
    const { loadOverview } = await import("./sales-reports.access.server");
    return loadOverview(context.supabase, context.userId, data.runId ?? null);
  });

export const getSalesRepDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { runId?: string | null; repCode?: string | null }) => data ?? {})
  .handler(async ({ data, context }) => {
    const { loadRepDetail } = await import("./sales-reports.access.server");
    return loadRepDetail(context.supabase, context.userId, data.runId ?? null, data.repCode ?? null);
  });

export const runSalesReportsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertAdmin } = await import("./p21.server");
    await assertAdmin(context.supabase, context.userId);
    const { runSalesReports } = await import("./sales-reports.server");
    return runSalesReports({ triggeredBy: context.userId });
  });

export const exportSalesRepWorkbook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
