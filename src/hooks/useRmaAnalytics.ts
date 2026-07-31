import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getRmaDataSource,
  saveRmaDataSource,
  testRmaSql,
  runRmaSnapshotNow,
  getRmaOverview,
  getRmaAttribution,
  listRmaRows,
  listRmaEntityMonthly,
  getRmaOrderIndex,
} from "@/lib/rma.functions";

export type RmaRange = { from?: string | null; to?: string | null };

export function useRmaOverview(range: RmaRange) {
  const fn = useServerFn(getRmaOverview);
  return useQuery({
    queryKey: ["rma-overview", range.from ?? null, range.to ?? null],
    queryFn: () => fn({ data: range }),
  });
}

export function useRmaAttribution(range: RmaRange, config: { minIncidents: number; multiple: number }) {
  const fn = useServerFn(getRmaAttribution);
  return useQuery({
    queryKey: ["rma-attribution", range.from ?? null, range.to ?? null, config.minIncidents, config.multiple],
    queryFn: () => fn({ data: { ...range, ...config } }),
  });
}

export function useRmaRows(vars: RmaRange & { search?: string; bucket?: string }) {
  const fn = useServerFn(listRmaRows);
  return useQuery({
    queryKey: ["rma-rows", vars.from ?? null, vars.to ?? null, vars.search ?? "", vars.bucket ?? "all"],
    queryFn: () => fn({ data: vars }),
  });
}

export function useRmaEntityMonthly(vars: { dimensionType?: any; dimensionKey?: string } = {}, enabled = true) {
  const fn = useServerFn(listRmaEntityMonthly);
  return useQuery({
    queryKey: ["rma-entity-monthly", vars.dimensionType ?? null, vars.dimensionKey ?? null],
    queryFn: () => fn({ data: vars }),
    enabled,
  });
}

export function useRmaDataSource(enabled = true) {
  const fn = useServerFn(getRmaDataSource);
  return useQuery({ queryKey: ["rma-data-source"], queryFn: () => fn(), enabled, retry: false });
}

export function useSaveRmaDataSource() {
  const fn = useServerFn(saveRmaDataSource);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sql: string | null) => fn({ data: { sql } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rma-data-source"] }); },
  });
}

export function useTestRmaSql() {
  const fn = useServerFn(testRmaSql);
  return useMutation({ mutationFn: (sql: string) => fn({ data: { sql } }) });
}

export function useRunRmaSnapshot() {
  const fn = useServerFn(runRmaSnapshotNow);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fn(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rma-data-source"] });
      qc.invalidateQueries({ queryKey: ["rma-overview"] });
      qc.invalidateQueries({ queryKey: ["rma-attribution"] });
      qc.invalidateQueries({ queryKey: ["rma-rows"] });
      qc.invalidateQueries({ queryKey: ["rma-entity-monthly"] });
    },
  });
}

/** Uppercased order/RMA keys present in the active snapshot (damage cross-link). */
export function useRmaOrderIndex() {
  const fn = useServerFn(getRmaOrderIndex);
  return useQuery({
    queryKey: ["rma-order-index"],
    queryFn: () => fn(),
    staleTime: 5 * 60 * 1000,
  });
}
