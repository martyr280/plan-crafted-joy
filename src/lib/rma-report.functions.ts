import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { denyLegacyBranchAccess } from "@/lib/branch-guard";
import { addOneDay, buildLinesSql, buildSalesSql } from "@/lib/rma-report/sql";
import type { RmaLine, RmaSalesRow } from "@/lib/rma-report/aggregate";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z
  .object({ from: Day, to: Day })
  .refine((v) => v.from.slice(0, 7) === v.to.slice(0, 7), "from and to must be in the same calendar month")
  .refine((v) => v.from <= v.to, "from must be on or before to")
  .refine((v) => !Number.isNaN(Date.parse(`${v.from}T00:00:00Z`)) && !Number.isNaN(Date.parse(`${v.to}T00:00:00Z`)), "invalid date");

/** Agent-side query kill (not our own wait timeout, which would not be helped by splitting). */
function isAgentTimeout(e: unknown): boolean {
  const m = String((e as any)?.message ?? e);
  if (/is the agent running/i.test(m)) return false;
  return /timeout|timed out/i.test(m);
}

async function pullRange(from: string, to: string) {
  const { runJob } = await import("@/lib/p21.server");
  const toExclusive = addOneDay(to);
  const run = async (sql: string, slug: string) => {
    const { result } = await runJob("sql.select", { sql, params: {}, slug, maxRows: 20000 }, 60000);
    if ((result as any)?.truncated) throw new Error(`${slug} result was truncated; refusing a partial month`);
    return ((result as any)?.rows ?? []) as any[];
  };
  const [lines, sales] = await Promise.all([
    run(buildLinesSql(from, toExclusive), "rma-report-lines"),
    run(buildSalesSql(from, toExclusive), "rma-report-sales"),
  ]);
  return { lines: lines as RmaLine[], sales: sales as RmaSalesRow[] };
}

export const pullRmaReportMonth = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((i) => Input.parse(i))
  .handler(async ({ data }) => {
    const { from, to } = data;
    let out: { lines: RmaLine[]; sales: RmaSalesRow[] };
    try {
      out = await pullRange(from, to);
    } catch (e) {
      if (!isAgentTimeout(e) || from === to) throw e;
      // Retry once as two halves. Sales rows are per customer+group, so halves are summed.
      const mid = new Date(`${from}T00:00:00Z`);
      const span = (Date.parse(`${to}T00:00:00Z`) - mid.getTime()) / 86400000;
      mid.setUTCDate(mid.getUTCDate() + Math.floor(span / 2));
      const midDay = mid.toISOString().slice(0, 10);
      const a = await pullRange(from, midDay);
      const b = await pullRange(addOneDay(midDay), to);
      const salesMap = new Map<string, RmaSalesRow>();
      for (const r of [...a.sales, ...b.sales]) {
        const k = `${r.customer_id}|${r.product_group_id ?? ""}`;
        const prev = salesMap.get(k);
        if (prev) prev.sales = Number(prev.sales) + Number(r.sales);
        else salesMap.set(k, { ...r, sales: Number(r.sales) });
      }
      out = { lines: [...a.lines, ...b.lines], sales: [...salesMap.values()] };
    }
    return { from, to, lines: out.lines, sales: out.sales, pulledAt: new Date().toISOString() };
  });
