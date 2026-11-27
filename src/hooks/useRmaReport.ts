import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { pullRmaReportMonth } from "@/lib/rma-report.functions";
import { splitMonths, type RmaLine, type RmaSalesRow } from "@/lib/rma-report/aggregate";

export type MonthState = { month: string; from: string; to: string; status: "pending" | "loading" | "done" | "error"; error?: string; lines?: RmaLine[]; sales?: RmaSalesRow[] };
const STALE = 30 * 60 * 1000;
const CONCURRENCY = 3;

export function useRmaReport() {
  const qc = useQueryClient();
  const pull = useServerFn(pullRmaReportMonth);
  const [months, setMonths] = useState<MonthState[]>([]);
  const runId = useRef(0);

  const fetchOne = useCallback(async (id: number, m: { month: string; from: string; to: string }) => {
    const set = (patch: Partial<MonthState>) => { if (runId.current === id) setMonths((xs) => xs.map((x) => (x.month === m.month ? { ...x, ...patch } : x))); };
    set({ status: "loading", error: undefined });
    try {
      const r = await qc.fetchQuery({ queryKey: ["rma-report-month", m.from, m.to], queryFn: () => pull({ data: { from: m.from, to: m.to } }), staleTime: STALE });
      set({ status: "done", lines: r.lines, sales: r.sales });
    } catch (e: any) {
      set({ status: "error", error: e?.message ?? String(e) });
    }
  }, [qc, pull]);

  const run = useCallback(async (from: string, to: string) => {
    const id = ++runId.current;
    const ms = splitMonths(from, to);
    setMonths(ms.map((m) => ({ ...m, status: "pending" })));
    let i = 0;
    const worker = async () => { while (i < ms.length && runId.current === id) { const m = ms[i++]!; await fetchOne(id, m); } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ms.length) }, worker));
  }, [fetchOne]);

  const retry = useCallback((month: string) => {
    const m = months.find((x) => x.month === month);
    if (m) void fetchOne(runId.current, m);
  }, [months, fetchOne]);

  return { months, run, retry };
}
