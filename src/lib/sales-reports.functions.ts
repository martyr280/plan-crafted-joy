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

export const runSalesReportForRep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
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
