// Page through a PostgREST query with .range() windows. PostgREST caps every
// response at its max-rows setting (1,000) regardless of .limit(), so any read
// that can exceed that must page. Throws on error; never returns a partial set.

export const FETCH_ALL_MAX_PAGES = 200;

export async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  pageSize = 1000,
  maxPages = FETCH_ALL_MAX_PAGES,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) throw new Error(`fetchAllRows page ${page + 1} failed: ${error.message ?? String(error)}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error(`fetchAllRows exceeded ${maxPages} pages of ${pageSize} rows; refusing to return a partial set`);
}
