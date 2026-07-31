import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listCapacityAlertRules, saveCapacityAlertRule, deleteCapacityAlertRule,
  evaluateCapacityAlertsNow, listCapacityAlertLog,
  listCapacityAlerts, setCapacityAlertStatus,
  listCapacityAlertPrefs, saveCapacityAlertPref,
  getCapacityAlertSettings, saveCapacityAlertSettings,
} from "@/lib/capacity-alerts.functions";

export function useCapacityAlertRules(enabled = true) {
  const fn = useServerFn(listCapacityAlertRules);
  return useQuery({ queryKey: ["capacity-alert-rules"], queryFn: () => fn(), enabled });
}

export function useSaveCapacityAlertRule() {
  const fn = useServerFn(saveCapacityAlertRule);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => fn({ data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["capacity-alert-rules"] }); },
  });
}

export function useDeleteCapacityAlertRule() {
  const fn = useServerFn(deleteCapacityAlertRule);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["capacity-alert-rules"] }); },
  });
}

export function useEvaluateCapacityAlerts() {
  const fn = useServerFn(evaluateCapacityAlertsNow);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { dryRun: boolean; ruleId?: string | null }) => fn({ data: vars }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["capacity-alert-log"] });
      if (!vars.dryRun) qc.invalidateQueries({ queryKey: ["capacity-alerts"] });
    },
  });
}

export function useCapacityAlertLog(enabled = true) {
  const fn = useServerFn(listCapacityAlertLog);
  return useQuery({ queryKey: ["capacity-alert-log"], queryFn: () => fn({ data: { limit: 200 } }), enabled });
}

export function useCapacityAlerts(status: "all" | "open" = "all", enabled = true) {
  const fn = useServerFn(listCapacityAlerts);
  return useQuery({
    queryKey: ["capacity-alerts", status],
    queryFn: () => fn({ data: { status, limit: 200 } }),
    enabled,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useSetCapacityAlertStatus() {
  const fn = useServerFn(setCapacityAlertStatus);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; status: "new" | "acknowledged" | "resolved" }) => fn({ data: vars }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["capacity-alerts"] }); },
  });
}

export function useCapacityAlertPrefs(enabled = true) {
  const fn = useServerFn(listCapacityAlertPrefs);
  return useQuery({ queryKey: ["capacity-alert-prefs"], queryFn: () => fn(), enabled });
}

export function useSaveCapacityAlertPref() {
  const fn = useServerFn(saveCapacityAlertPref);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { rep_code: string; opted_in: boolean; max_per_week: number; email_override?: string | null }) => fn({ data }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["capacity-alert-prefs"] }); },
  });
}

export function useCapacityAlertSettings(enabled = true) {
  const fn = useServerFn(getCapacityAlertSettings);
  return useQuery({ queryKey: ["capacity-alert-settings"], queryFn: () => fn(), enabled });
}

export function useSaveCapacityAlertSettings() {
  const fn = useServerFn(saveCapacityAlertSettings);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (managerEmails: string[]) => fn({ data: { managerEmails } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["capacity-alert-settings"] }); },
  });
}
