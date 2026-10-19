// Browser-safe complete-or-throw pager; never accepts a missing exact count.
export async function pageAll<T>(
  q: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null; count: number | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let total: number | null = null;
  for (let from = 0; ; from += PAGE) {
    const { data, error, count } = await q(from, from + PAGE - 1);
    if (error) throw new Error(error.message ?? String(error));
    if (typeof count !== "number") throw new Error("no exact row count returned — aborting to avoid a truncated result");
    if (total !== null && total !== count) throw new Error("row count changed during paging");
    total = count;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE || out.length >= total) break;
  }
  if (out.length !== total) throw new Error(`fetched ${out.length} of ${total} rows`);
  return out;
}