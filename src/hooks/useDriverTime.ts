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
  getDriverRoster,
  setDriverRosterVisibility,
  addDriverPayRate,
  updateDriverPayRate,
  getSamsaraDiagnostics,
  saveWarehouseActual,
} from "@/lib/driver-time.functions";
import type { WarehouseActual } from "@/lib/driver-time/reconciliation";

export function useDriverTimeWeek(weekStart?: string, enabled = true, includeWeekends = false) {
  const fn = useServerFn(getDriverTimeWeek);
  return useQuery({
    queryKey: ["driver-time-week", weekStart ?? "current", includeWeekends],
    queryFn: () => fn({ data: {weekStart, includeWeekends} }),
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
    mutationFn: (weekStart?: string) => fn({data:{weekStart}}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["driver-time-week"] }),
  });
}

export function useSaveWarehouseActual() {
  const fn = useServerFn(saveWarehouseActual);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {driverId:string;weekStart:string;actual:WarehouseActual|null;expectedUpdatedAt:string|null}) => fn({data}),
    onSuccess: () => qc.invalidateQueries({queryKey:["driver-time-week"]}),
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
      requireLicense?: boolean;
      includeDeactivated?: boolean;
      basis?: "presence" | "onduty";
      warehouseRemarkDriverIds?: string[];

    }) => fn({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["driver-time-config"] });
      qc.invalidateQueries({ queryKey: ["driver-time-week"] });
    },
  });
}

/** Driver-pay managers only: callers must pass enabled=false for anyone else. */
export function useDriverPayRates(enabled = true, includeExcluded = false) {
  const fn = useServerFn(listDriverPayRates);
  return useQuery({
    queryKey: ["driver-pay-rates", includeExcluded],
    queryFn: () => fn({ data: { includeExcluded } }),
    enabled,
  });
}

/** Driver-pay managers only: callers must pass enabled=false for anyone else. */
export function useDriverRoster(enabled = true) {
  const fn = useServerFn(getDriverRoster);
  return useQuery({ queryKey: ["driver-roster"], queryFn: () => fn(), enabled });
}

export function useSetDriverRosterVisibility() {
  const fn = useServerFn(setDriverRosterVisibility);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { driverId: string; hidden: boolean; expectedUpdatedAt: string | null }) =>
      fn({ data: vars }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["driver-roster"] });
      qc.invalidateQueries({ queryKey: ["driver-pay-rates"] });
      qc.invalidateQueries({ queryKey: ["driver-time-config"] });
      qc.invalidateQueries({ queryKey: ["driver-time-week"] });
    },
  });
}

function useRateMutation<V>(serverFn: any) {
  const fn = useServerFn(serverFn) as (a: { data: V }) => Promise<unknown>;
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: V) => fn({ data: vars }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["driver-pay-rates"] });
      qc.invalidateQueries({ queryKey: ["driver-time-week"] });
    },
  });
}

export function useAddDriverPayRate() {
  return useRateMutation<{ driverId: string; driverName: string | null; hourlyRate: number; effectiveDate: string }>(addDriverPayRate);
}

export function useUpdateDriverPayRate() {
  return useRateMutation<{ id: string; hourlyRate: number; effectiveDate: string; expectedUpdatedAt: string }>(updateDriverPayRate);
}

export function useSamsaraDiagnostics() {
  const fn = useServerFn(getSamsaraDiagnostics);
  return useMutation({
    mutationFn: (vars?: { lookbackDays?: number }) => fn({ data: vars ?? {} }),
  });
}
