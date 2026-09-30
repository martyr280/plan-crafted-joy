import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getSalesReportOverview,
  getSalesRepDetail,
  listSalesReportRuns,
  runSalesReportsNow,
  exportSalesRepWorkbook,
  runSalesReportForRep,
  getSalesReportDrilldown,
} from "@/lib/sales-reports.functions";
import type { DrilldownKind } from "@/lib/sales-reports.drilldown";

export function useSalesReportRuns() {
  const fn = useServerFn(listSalesReportRuns);
  return useQuery({
    queryKey: ["sales-report-runs"],
    queryFn: () => fn(),
  });
}

export function useSalesReportOverview(runId: string | null) {
  const fn = useServerFn(getSalesReportOverview);
  return useQuery({
    queryKey: ["sales-report-overview", runId],
    queryFn: () => fn({ data: { runId } }),
  });
}

export function useSalesRepDetail(runId: string | null, repCode: string | null, enabled = true) {
  const fn = useServerFn(getSalesRepDetail);
  return useQuery({
    queryKey: ["sales-report-detail", runId, repCode],
    queryFn: () => fn({ data: { runId, repCode } }),
    enabled,
  });
}

export function useRunSalesReports() {
  const fn = useServerFn(runSalesReportsNow);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fn(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sales-report-runs"] });
      qc.invalidateQueries({ queryKey: ["sales-report-overview"] });
      qc.invalidateQueries({ queryKey: ["sales-report-detail"] });
    },
  });
}

export function useExportRepWorkbook() {
  const fn = useServerFn(exportSalesRepWorkbook);
  return useMutation({
    mutationFn: (vars: { runId: string; repCode: string }) => fn({ data: vars }),
    onSuccess: (res: { filename: string; contentBase64: string }) => {
      const bytes = Uint8Array.from(atob(res.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export function useTestOneRep() {
  const fn = useServerFn(runSalesReportForRep);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { repCode: string; year: number; month: number; persist: boolean }) => fn({ data: vars }),
    onSuccess: (_r, vars) => {
      if (vars.persist) qc.invalidateQueries({ queryKey: ["sales-report-runs"] });
    },
  });
}

export function useSalesReportDrilldown(runId: string | null, kind: DrilldownKind | null) {
  const fn = useServerFn(getSalesReportDrilldown);
  return useQuery({
    queryKey: ["sales-report-drilldown", runId, kind],
    queryFn: () => fn({ data: { runId, kind: kind! } }),
    enabled: !!kind,
    staleTime: 60_000,
  });
}

import {
  listRepContacts, saveRepContact, getEmailSendList, previewSalesReportEmails, sendSalesReportEmails,
} from "@/lib/sales-reports.functions";

export function useRepContacts() {
  const fn = useServerFn(listRepContacts);
  return useQuery({ queryKey: ["sales-rep-contacts"], queryFn: () => fn() });
}

export function useSaveRepContact() {
  const fn = useServerFn(saveRepContact);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { rep_code: string; email: string | null; cc_emails: string[]; send_enabled: boolean; notes: string | null }) => fn({ data: v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sales-rep-contacts"] }); qc.invalidateQueries({ queryKey: ["sales-email-list"] }); },
  });
}

export function useEmailSendList(runId: string | null) {
  const fn = useServerFn(getEmailSendList);
  return useQuery({ queryKey: ["sales-email-list", runId], queryFn: () => fn({ data: { runId } }) });
}

export function usePreviewEmails() {
  const fn = useServerFn(previewSalesReportEmails);
  return useMutation({ mutationFn: (v: { runId: string; repCodes: string[]; sendAgain: boolean; testMode: boolean }) => fn({ data: v }) });
}

export function useSendEmails() {
  const fn = useServerFn(sendSalesReportEmails);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string; repCodes: string[]; sendAgain: boolean; testMode: boolean; expectedRows: Record<string, number> }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales-email-list"] }),
  });
}

import { rematchRepEmailsFromP21 } from "@/lib/sales-reports.functions";
export function useRematchRepEmails() {
  const fn = useServerFn(rematchRepEmailsFromP21);
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => fn(), onSuccess: () => { qc.invalidateQueries({ queryKey: ["sales-rep-contacts"] }); qc.invalidateQueries({ queryKey: ["sales-email-list"] }); } });
}
