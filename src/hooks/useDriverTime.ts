import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getDriverTimeWeek,
  updateDriverTimeEventStatus,
  setPaycomHours,
  runDriverTimeSweepNow,
  getDriverTimeConfig,
  saveDriverTimeConfig,
  listDriverPayRates,
  importDriverPayRates,
  getSamsaraDiagnostics,
} from "@/lib/driver-time.functions";

export function useDriverTimeWeek(weekStart?: string, enabled = true) {
  const fn = useServerFn(getDriverTimeWeek);
  return useQuery({
    queryKey: ["driver-time-week", weekStart ?? "current"],
    queryFn: () => fn({ data: weekStart ? { weekStart } : {} }),
    enabled,
  });
}

export function useUpdateDriverTimeEvent() {
  const fn = useServerFn(updateDriverTimeEventStatus);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; status: "new" | "reviewed" | "excused"; notes?: string | null }) =>
      fn({ data: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["driver-time-week"] }),
  });
}

export function useSetPaycomHours() {
  const fn = useServerFn(setPaycomHours);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { driverId: string; weekStart: string; paycomHours: number | null }) => fn({ data: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["driver-time-week"] }),
  });
}

export function useRunDriverTimeSweep() {
  const fn = useServerFn(runDriverTimeSweepNow);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["driver-time-week"] }),
  });
}

export function useDriverTimeConfig(enabled = true) {
  const fn = useServerFn(getDriverTimeConfig);
  return useQuery({ queryKey: ["driver-time-config"], queryFn: () => fn(), enabled });
}

export function useSaveDriverTimeConfig() {
  const fn = useServerFn(saveDriverTimeConfig);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: {
      warehouseAddressIds?: string[];
      thresholdMinutes?: number;
      excludedDriverIds?: string[];
      excludedDriverNamePatterns?: string[];
      mergeGapMinutes?: number;
    }) => fn({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["driver-time-config"] });
      qc.invalidateQueries({ queryKey: ["driver-time-week"] });
    },
  });
}

export function useDriverPayRates(enabled = true) {
  const fn = useServerFn(listDriverPayRates);
  return useQuery({ queryKey: ["driver-pay-rates"], queryFn: () => fn(), enabled });
}

export function useImportDriverPayRates() {
  const fn = useServerFn(importDriverPayRates);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { text: string; effectiveDate?: string }) => fn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["driver-pay-rates"] });
      qc.invalidateQueries({ queryKey: ["driver-time-week"] });
    },
  });
}

export function useSamsaraDiagnostics() {
  const fn = useServerFn(getSamsaraDiagnostics);
  return useMutation({
    mutationFn: (vars?: { lookbackDays?: number }) => fn({ data: vars ?? {} }),
  });
}
