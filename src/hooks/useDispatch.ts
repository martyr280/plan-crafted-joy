// TanStack Query bindings for the Samsara Route Dispatch module.
// All server state lives here; the route component never calls a server fn
// directly.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  approveAndPush,
  buildRunNow,
  cancelRun,
  getDispatchRun,
  getDispatchSettingsFn,
  importSequencePaste,
  listAddressQueue,
  listDispatchRuns,
  listDriverMappings,
  listSequenceTemplate,
  previewDelta,
  resolveAddress,
  saveDispatchSettingsFn,
  saveDriverMapping,
  saveSequenceTemplate,
  suggestAddressMatches,
  getDispatchBoard,
  refreshDispatchBoard,
  saveDispatchDateBasis,
  saveRunException,
  deleteRunException,
} from "@/lib/dispatch.functions";

export function useDispatchBoard() {
  const fn = useServerFn(getDispatchBoard);
  return useQuery({ queryKey: ["dispatch", "board"], queryFn: () => fn() });
}

export function useRefreshDispatchBoard() {
  const fn = useServerFn(refreshDispatchBoard);
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => fn(), onSuccess: (b) => qc.setQueryData(["dispatch", "board"], b) });
}

export function useSaveDispatchDateBasis() {
  const fn = useServerFn(saveDispatchDateBasis);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (basis: "pick_ticket_print" | "earliest_required" | "requested" | "promise") => fn({ data: { basis } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch", "board"] }),
  });
}

export function useDispatchRuns() {
  const fn = useServerFn(listDispatchRuns);
  return useQuery({ queryKey: ["dispatch", "runs"], queryFn: () => fn(), refetchInterval: 60_000 });
}

export function useDispatchRun(runId: string | null) {
  const fn = useServerFn(getDispatchRun);
  return useQuery({
    queryKey: ["dispatch", "run", runId],
    queryFn: () => fn({ data: { runId: runId! } }),
    enabled: Boolean(runId),
  });
}

export function useBuildRunNow() {
  const fn = useServerFn(buildRunNow);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { routeId: string; runDate?: string }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch"] }),
  });
}

export function useApproveAndPush() {
  const fn = useServerFn(approveAndPush);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch"] }),
  });
}

export function usePreviewDelta() {
  const fn = useServerFn(previewDelta);
  return useMutation({ mutationFn: (v: { runId: string }) => fn({ data: v }) });
}

export function useCancelRun() {
  const fn = useServerFn(cancelRun);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { runId: string }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch"] }),
  });
}

export function useAddressQueue() {
  const fn = useServerFn(listAddressQueue);
  return useQuery({ queryKey: ["dispatch", "addresses"], queryFn: () => fn() });
}

export function useSuggestAddressMatches() {
  const fn = useServerFn(suggestAddressMatches);
  return useMutation({
    mutationFn: (v: { addr1?: string | null; addr2?: string | null; city?: string | null; state?: string | null; zip?: string | null }) =>
      fn({ data: v }),
  });
}

export function useResolveAddress() {
  const fn = useServerFn(resolveAddress);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: Parameters<typeof resolveAddress>[0] extends never ? never : any) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch"] }),
  });
}

export function useSequenceTemplate(routeId: string | null) {
  const fn = useServerFn(listSequenceTemplate);
  return useQuery({
    queryKey: ["dispatch", "sequence", routeId],
    queryFn: () => fn({ data: { routeId: routeId! } }),
    enabled: Boolean(routeId),
  });
}

export function useSaveSequenceTemplate() {
  const fn = useServerFn(saveSequenceTemplate);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: any) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch", "sequence"] }),
  });
}

export function useImportSequencePaste() {
  const fn = useServerFn(importSequencePaste);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { routeId: string; text: string; commit?: boolean }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch", "sequence"] }),
  });
}

export function useDispatchSettings() {
  const fn = useServerFn(getDispatchSettingsFn);
  return useQuery({ queryKey: ["dispatch", "settings"], queryFn: () => fn() });
}

export function useSaveDispatchSettings() {
  const fn = useServerFn(saveDispatchSettingsFn);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: any) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch"] }),
  });
}

export function useDriverMappings() {
  const fn = useServerFn(listDriverMappings);
  return useQuery({ queryKey: ["dispatch", "drivers"], queryFn: () => fn() });
}

export function useSaveDriverMapping() {
  const fn = useServerFn(saveDriverMapping);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { routeId: string; samsaraDriverId?: string | null; driverNameRaw?: string | null; confirmed: boolean }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch", "drivers"] }),
  });
}

export function useSaveRunException() {
  const fn = useServerFn(saveRunException);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { p21Code: string; runDate: string; kind: "no_run" | "reduced"; reason: "short_week" | "driver_pto" | "other"; note?: string | null }) => fn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch", "board"] }),
  });
}

export function useDeleteRunException() {
  const fn = useServerFn(deleteRunException);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => fn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch", "board"] }),
  });
}
