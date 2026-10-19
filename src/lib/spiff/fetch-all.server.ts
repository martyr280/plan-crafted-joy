// SPIFF server reads use the shared complete-or-throw pager
// (src/lib/supabase-fetch-all.ts): order by unique `id`, count exact,
// concurrency 1, never a partial set.
import { fetchAllRows as sharedFetchAllRows, type PagedQuery } from "../supabase-fetch-all";

export type { PagedQuery };

export async function fetchAllRows<T>(
  buildQuery: () => PagedQuery<T>,
  opts?: { pageSize?: number; label?: string },
): Promise<T[]> {
  return sharedFetchAllRows<T>(buildQuery, {
    pageSize: opts?.pageSize,
    label: opts?.label ?? "fetchAllRows",
    orderBy: [{ column: "id", ascending: true }],
    concurrency: 1,
  });
}

function withId(columns: string): string {
  const c = columns.trim();
  if (c === "*" || /(^|,)\s*id\s*(,|$)/.test(c)) return c;
  return `id, ${c}`;
}

export async function fetchAllRunLines<T = any>(runId: string, columns: string, customerIds?: string[]): Promise<T[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const cols = withId(columns);
  return fetchAllRows<T>(
    () => {
      let q: any = supabaseAdmin.from("spiff_run_lines").select(cols, { count: "exact" }).eq("run_id", runId);
      if (customerIds && customerIds.length) q = q.in("customer_id", customerIds);
      return q;
    },
    { label: `spiff_run_lines(run ${runId})` },
  );
}

export async function fetchAllRunChecks<T = any>(runId: string, columns: string, customerIds?: string[]): Promise<T[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const cols = withId(columns);
  return fetchAllRows<T>(
    () => {
      let q: any = supabaseAdmin.from("spiff_checks").select(cols, { count: "exact" }).eq("run_id", runId);
      if (customerIds && customerIds.length) q = q.in("customer_id", customerIds);
      return q;
    },
    { label: `spiff_checks(run ${runId})` },
  );
}
