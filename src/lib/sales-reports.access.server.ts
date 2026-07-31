// Access resolution + read helpers for Sales Reports.
import { fetchRunRows, summarizeByRep, reportPeriod, type SalesReportRow } from "./sales-reports.server";
import { SHORT_MONTH_NAMES } from "./sales-annualized-template";

export type SalesAccess = { canManage: boolean; isRep: boolean; repCode: string | null };

export async function resolveAccess(client: any, userId: string): Promise<SalesAccess> {
  const check = async (role: string) => {
    const { data } = await client.rpc("has_role", { _user_id: userId, _role: role });
    return !!data;
  };
  const [isAdmin, isManager, isRep] = await Promise.all([
    check("admin"),
    check("sales_manager"),
    check("sales_rep"),
  ]);
  let repCode: string | null = null;
  if (isRep) {
    const { data } = await client.from("profiles").select("sales_rep_code").eq("id", userId).maybeSingle();
    repCode = data?.sales_rep_code ?? null;
  }
  return { canManage: isAdmin || isManager, isRep, repCode };
}

async function resolveRunId(client: any, runId: string | null) {
  if (runId) {
    const { data } = await client
      .from("sales_report_runs")
      .select("id, run_at, period_year, period_month, status, rep_count, error")
      .eq("id", runId)
      .maybeSingle();
    return data ?? null;
  }
  const { data } = await client
    .from("sales_report_runs")
    .select("id, run_at, period_year, period_month, status, rep_count, error")
    .in("status", ["done", "partial"])
    .order("run_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

function monthLabelFor(run: any) {
  const idx = Math.max(0, Math.min(11, (run?.period_month ?? reportPeriod().month) - 1));
  return SHORT_MONTH_NAMES[idx];
}

export async function loadOverview(client: any, userId: string, runId: string | null) {
  const access = await resolveAccess(client, userId);
  const run = await resolveRunId(client, runId);
  if (!run) return { access, run: null, monthLabel: monthLabelFor(null), reps: [] };
  if (!access.canManage) {
    return { access, run, monthLabel: monthLabelFor(run), reps: [] };
  }
  const rows = await fetchRunRows(client, run.id);
  return { access, run, monthLabel: monthLabelFor(run), reps: summarizeByRep(rows) };
}

export async function loadRepDetail(client: any, userId: string, runId: string | null, repCode: string | null) {
  const access = await resolveAccess(client, userId);
  const effectiveRep = access.canManage ? repCode : access.repCode;
  const run = await resolveRunId(client, runId);
  if (!run || !effectiveRep) {
    return { access, run, monthLabel: monthLabelFor(run), repCode: effectiveRep, rows: [] as SalesReportRow[] };
  }
  const rows = await fetchRunRows(client, run.id, effectiveRep);
  return { access, run, monthLabel: monthLabelFor(run), repCode: effectiveRep, rows };
}
