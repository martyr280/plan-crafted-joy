import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getWebsiteExportStatus,
  saveWebsiteExportConfig,
  runWebsiteExportNow,
  probeWebsiteExportDeliveryFn,
} from "@/lib/website-export.functions";

export function useProbeWebsiteExportDelivery() {
  const fn = useServerFn(probeWebsiteExportDeliveryFn);
  return useMutation({
    mutationFn: (vars: { paths?: string[] } = {}) => fn({ data: vars } as any),
  });
}

export function useWebsiteExportStatus(enabled = true) {
  const fn = useServerFn(getWebsiteExportStatus);
  return useQuery({
    queryKey: ["website-export-status"],
    queryFn: () => fn({ data: {} } as any),
    enabled,
  });
}

export function useSaveWebsiteExportConfig() {
  const fn = useServerFn(saveWebsiteExportConfig);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: Record<string, unknown>) => fn({ data: vars } as any),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["website-export-status"] }),
  });
}

export function useRunWebsiteExport() {
  const fn = useServerFn(runWebsiteExportNow);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { dryRun?: boolean }) => fn({ data: vars } as any),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["website-export-status"] }),
  });
}
