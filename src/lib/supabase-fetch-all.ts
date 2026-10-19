// The ONE complete-or-throw pager for PostgREST reads. PostgREST caps every
// response at max-rows (1,000) regardless of .limit(), so any read that can
// exceed that must page. Contract:
//   - buildQuery() returns a FRESH query built with select(..., { count: "exact" })
//   - the pager applies .order() on orderBy (must end with a unique column) and .range()
//   - throws on any page error, a null count, a count that changes between pages,
//     a page-count overflow (maxPages), or fetched length !== count.
// It never returns a partial set. SPIFF re-exports this via spiff/fetch-all.server.

export type PageResult<T> = { data: T[] | null; error: { message?: string } | null; count: number | null };

export interface PagedQuery<T> {
  order(column: string, opts?: { ascending?: boolean }): PagedQuery<T>;
  range(from: number, to: number): PromiseLike<PageResult<T>>;
}

export type OrderSpec = { column: string; ascending?: boolean };

export type FetchAllOptions = {
  pageSize?: number;
  label?: string;
  /** Must end with a unique column (default [{ column: "id" }]). */
  orderBy?: OrderSpec[];
  /** Columns accepted as the unique tail of orderBy. Default ["id"]. */
  uniqueColumns?: string[];
  /** Parallel page fetches after page 1 established the count. Default 1. */
  concurrency?: number;
  maxPages?: number;
};

export const FETCH_ALL_MAX_PAGES = 200;

export async function fetchAllRows<T>(buildQuery: () => PagedQuery<T>, opts?: FetchAllOptions): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const label = opts?.label ?? "fetchAllRows";
  const orderBy = opts?.orderBy ?? [{ column: "id" }];
  const unique = opts?.uniqueColumns ?? ["id"];
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? 1));
  const maxPages = opts?.maxPages ?? FETCH_ALL_MAX_PAGES;
  const tail = orderBy[orderBy.length - 1];
  if (!tail || !unique.includes(tail.column)) {
    throw new Error(`${label}: orderBy must end with a unique column (${unique.join("/")}) — got ${tail?.column ?? "nothing"}`);
  }

  const fetchPage = async (page: number): Promise<{ rows: T[]; count: number }> => {
    const from = page * pageSize;
    let q = buildQuery();
    for (const o of orderBy) q = q.order(o.column, { ascending: o.ascending ?? true });
    const { data, error, count } = await q.range(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: page starting at ${from} failed: ${error.message ?? String(error)}`);
    if (typeof count !== "number") throw new Error(`${label}: no exact row count returned — aborting to avoid a truncated result`);
    return { rows: data ?? [], count };
  };

  const first = await fetchPage(0);
  const total = first.count;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages > maxPages) throw new Error(`${label}: ${total} rows exceed ${maxPages} pages of ${pageSize}; refusing to return a partial set`);

  const results: T[][] = new Array(pages);
  results[0] = first.rows;
  let next = 1;
  const worker = async () => {
    while (next < pages) {
      const page = next++;
      const r = await fetchPage(page);
      if (r.count !== total) throw new Error(`${label}: row count changed during paging (${total} → ${r.count})`);
      results[page] = r.rows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pages - 1) }, worker));

  const out: T[] = [];
  for (const r of results) out.push(...(r ?? []));
  if (out.length !== total) {
    throw new Error(`${label}: fetched ${out.length} of ${total} rows — aborting to avoid a truncated result`);
  }
  return out;
}

/**
 * Top-N read: the first `limit` rows in a stable order, never reading past them.
 * One request when limit <= pageSize; otherwise pages of pageSize until `limit`
 * rows are collected or a short page ends the table. Throws on any page error.
 */
export async function fetchFirstRows<T>(
  buildQuery: () => PagedQuery<T>,
  limit: number,
  opts?: { pageSize?: number; label?: string; orderBy?: OrderSpec[]; uniqueColumns?: string[] },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const label = opts?.label ?? "fetchFirstRows";
  const orderBy = opts?.orderBy ?? [{ column: "id" }];
  const unique = opts?.uniqueColumns ?? ["id"];
  const tail = orderBy[orderBy.length - 1];
  if (!tail || !unique.includes(tail.column)) {
    throw new Error(`${label}: orderBy must end with a unique column (${unique.join("/")}) — got ${tail?.column ?? "nothing"}`);
  }
  const out: T[] = [];
  while (out.length < limit) {
    const from = out.length;
    const want = Math.min(pageSize, limit - from);
    let q = buildQuery();
    for (const o of orderBy) q = q.order(o.column, { ascending: o.ascending ?? true });
    const { data, error } = await q.range(from, from + want - 1);
    if (error) throw new Error(`${label}: page starting at ${from} failed: ${error.message ?? String(error)}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < want) break;
  }
  return out.slice(0, limit);
}
