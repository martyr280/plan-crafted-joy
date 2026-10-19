// Complete-or-throw paging for SPIFF server reads. PostgREST caps every
// response at max-rows (1,000) regardless of .limit(), so any SPIFF read that
// can exceed that must page. Ordering by the unique `id` keeps pages stable;
// `count: 'exact'` lets us prove the result is complete before using it.

type PageResult<T> = { data: T[] | null; error: { message?: string } | null; count: number | null };

export interface PagedQuery<T> {
  order(column: string, opts?: { ascending?: boolean }): PagedQuery<T>;
  range(from: number, to: number): PromiseLike<PageResult<T>>;
}

export async function fetchAllRows<T>(
  buildQuery: () => PagedQuery<T>,
  opts?: { pageSize?: number; label?: string },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const label = opts?.label ?? "fetchAllRows";
  const out: T[] = [];
  let total: number | null = null;
  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await buildQuery()
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: page starting at ${from} failed: ${error.message ?? String(error)}`);
    if (typeof count === "number") total = count;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    if (total !== null && out.length >= total) break;
  }
  if (total === null) throw new Error(`${label}: no exact row count returned — aborting to avoid a truncated result`);
  if (out.length !== total) {
    throw new Error(`${label}: fetched ${out.length} of ${total} rows — aborting to avoid a truncated result`);
  }
  return out;
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
