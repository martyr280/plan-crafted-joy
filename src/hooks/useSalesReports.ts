import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getSalesReportOverview,
  getSalesRepDetail,
  listSalesReportRuns,
  runSalesReportsNow,
  exportSalesRepWorkbook,
} from "@/lib/sales-reports.functions";

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
