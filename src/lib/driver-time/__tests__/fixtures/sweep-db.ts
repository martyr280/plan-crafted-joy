// In-memory stand-in for the service-role client, for the resumable-sweep
// tests. Supports the PostgREST builder subset the sweep, the cache layer and
// the legacy single-shot copy use. No network, no credentials, synthetic data.
// `killAfter(n)` simulates the worker dying: the n-th call and every call
// after it throw until `revive()`.

type Row = Record<string, any>;

let seq = 0;
const uuid = () => {
  seq++;
  // Random-looking but deterministic ids, so "order by id" is not insertion order
  // (like gen_random_uuid in the real table).
  const h = ((seq * 2654435761) >>> 0).toString(16).padStart(8, "0");
  return `${h}-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
};

export const sweepDb = {
  tables: {} as Record<string, Row[]>,
  calls: 0,
  killAt: Infinity,
  ops: [] as Array<{ table: string; op: string; range?: boolean; or?: string }>,
  hook: null as null | ((table: string, op: string) => void),
};

export class KilledError extends Error {
  constructor() {
    super("worker killed (test)");
  }
}

export function resetSweepDb(tables: Record<string, Row[]> = {}) {
  sweepDb.tables = structuredClone(tables);
  sweepDb.calls = 0;
  sweepDb.killAt = Infinity;
  sweepDb.ops = [];
  sweepDb.hook = null;
}
export function killAfter(n: number) {
  sweepDb.calls = 0;
  sweepDb.killAt = n;
}
export function revive() {
  sweepDb.killAt = Infinity;
}
export const snapshot = () => structuredClone(sweepDb.tables);

const DEFAULTS: Record<string, () => Row> = {
  driver_warehouse_runs: () => ({
    status: "running",
    started_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    completed_at: null,
    drivers_scanned: 0,
    events_found: 0,
    error: null,
    phase: null,
    cursor: {},
    heartbeat_at: null,
    lease_until: null,
    requested_week_start: null,
    refresh_hos: false,
    drivers_total: null,
    days_fetched: 0,
    steps: 0,
    last_step: null,
    step_log: [],
  }),
  samsara_cache_days: () => ({ complete: false, coverage: [], row_count: 0, error: null, fetched_at: new Date().toISOString() }),
  driver_warehouse_events: () => ({ status: "new", reviewed_by: null, reviewed_at: null, notes: null, superseded_at: null }),
};

function cmp(a: any, b: any): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const ta = typeof a === "string" && /^\d{4}-\d{2}-\d{2}T/.test(a) ? Date.parse(a) : a;
  const tb = typeof b === "string" && /^\d{4}-\d{2}-\d{2}T/.test(b) ? Date.parse(b) : b;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

function parseVal(v: string): any {
  const s = v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
  return s === "null" ? null : s;
}

/** PostgREST `or` filter subset: comma list of col.op.val and and(...). */
function parseOr(expr: string): (r: Row) => boolean {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inQ = false;
  for (const ch of expr) {
    if (ch === '"') inQ = !inQ;
    if (!inQ && ch === "(") depth++;
    if (!inQ && ch === ")") depth--;
    if (!inQ && ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const preds = parts.map((p) => {
    if (p.startsWith("and(")) {
      const inner = p.slice(4, -1);
      const subs: string[] = [];
      let d = 0;
      let c = "";
      let q = false;
      for (const ch of inner) {
        if (ch === '"') q = !q;
        if (!q && ch === "(") d++;
        if (!q && ch === ")") d--;
        if (!q && ch === "," && d === 0) {
          subs.push(c);
          c = "";
        } else c += ch;
      }
      subs.push(c);
      const sp = subs.map(atom);
      return (r: Row) => sp.every((f) => f(r));
    }
    return atom(p);
  });
  return (r) => preds.some((f) => f(r));
}
function atom(p: string): (r: Row) => boolean {
  const i = p.indexOf(".");
  const col = p.slice(0, i);
  const rest = p.slice(i + 1);
  const j = rest.indexOf(".");
  const op = rest.slice(0, j);
  const val = parseVal(rest.slice(j + 1));
  switch (op) {
    case "is":
      return (r) => (val === null ? r[col] == null : r[col] === val);
    case "eq":
      return (r) => cmp(r[col], val) === 0 && r[col] != null;
    case "gt":
      return (r) => r[col] != null && cmp(r[col], val) > 0;
    case "lt":
      return (r) => r[col] != null && cmp(r[col], val) < 0;
    default:
      throw new Error(`fake or(): unsupported op ${op}`);
  }
}

function project(row: Row, cols: string): Row {
  if (!cols || cols.trim() === "*") return structuredClone(row);
  const out: Row = {};
  for (const c of cols.split(",").map((x) => x.trim())) out[c] = structuredClone(row[c] ?? null);
  return out;
}

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  let payload: any = null;
  let onConflict: string | null = null;
  let cols = "*";
  let returning = false;
  let countMode = false;
  let head = false;
  const orders: Array<{ col: string; asc: boolean }> = [];
  let limit = Infinity;
  let rangeFrom = 0;
  let rangeTo = Infinity;
  let usedRange = false;
  let orExpr: string | undefined;

  const exec = () => {
    sweepDb.calls++;
    if (sweepDb.calls >= sweepDb.killAt) throw new KilledError();
    sweepDb.ops.push({ table, op, range: usedRange, or: orExpr });
    sweepDb.hook?.(table, op);
    const rows = (sweepDb.tables[table] ??= []);
    const match = () => rows.filter((r) => filters.every((f) => f(r)));
    if (op === "insert" || op === "upsert") {
      const list = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ ...p }));
      const out: Row[] = [];
      for (const p of list) {
        if (op === "upsert" && onConflict) {
          const keys = onConflict.split(",");
          const hit = rows.find((r) => keys.every((k) => r[k] === p[k]));
          if (hit) {
            Object.assign(hit, structuredClone(p), { updated_at: new Date().toISOString() });
            out.push(hit);
            continue;
          }
        }
        if (table === "driver_warehouse_events" && rows.some((r) => r.driver_id === p.driver_id && Date.parse(r.start_ts) === Date.parse(p.start_ts))) {
          return { data: null, error: { code: "23505", message: "duplicate key driver_id,start_ts" }, count: null };
        }
        const row = { ...(DEFAULTS[table]?.() ?? {}), id: p.id ?? uuid(), ...structuredClone(p) };
        rows.push(row);
        out.push(row);
      }
      return { data: returning ? out.map((r) => project(r, cols)) : null, error: null, count: null };
    }
    if (op === "update") {
      const hit = match();
      for (const r of hit) Object.assign(r, structuredClone(payload), { updated_at: new Date().toISOString() });
      return { data: returning ? hit.map((r) => project(r, cols)) : null, error: null, count: null };
    }
    if (op === "delete") {
      const keep = rows.filter((r) => !filters.every((f) => f(r)));
      sweepDb.tables[table] = keep;
      return { data: null, error: null, count: null };
    }
    let all = match();
    if (orders.length)
      all = [...all].sort((a, b) => {
        for (const o of orders) {
          const c = cmp(a[o.col], b[o.col]);
          if (c) return o.asc ? c : -c;
        }
        return 0;
      });
    const total = all.length;
    const sliced = all.slice(0, limit).slice(rangeFrom, rangeTo + 1);
    if (usedRange && sliced.length > 1000) throw new Error("fake: page over max-rows");
    const capped = sliced.slice(0, 1000); // PostgREST max-rows
    return { data: head ? null : capped.map((r) => project(r, cols)), error: null, count: countMode ? total : null };
  };

  const q: any = {
    select: (c?: string, o?: { count?: string; head?: boolean }) => {
      if (op !== "select") returning = true;
      cols = c ?? "*";
      if (o?.count === "exact") countMode = true;
      if (o?.head) head = true;
      return q;
    },
    insert: (p: any) => ((op = "insert"), (payload = p), q),
    upsert: (p: any, o?: { onConflict?: string }) => ((op = "upsert"), (payload = p), (onConflict = o?.onConflict ?? null), q),
    update: (p: any) => ((op = "update"), (payload = p), q),
    delete: () => ((op = "delete"), q),
    eq: (k: string, v: any) => (filters.push((r) => r[k] != null && cmp(r[k], v) === 0), q),
    neq: (k: string, v: any) => (filters.push((r) => cmp(r[k], v) !== 0), q),
    in: (k: string, v: any[]) => (filters.push((r) => v.some((x) => cmp(r[k], x) === 0)), q),
    gte: (k: string, v: any) => (filters.push((r) => r[k] != null && cmp(r[k], v) >= 0), q),
    gt: (k: string, v: any) => (filters.push((r) => r[k] != null && cmp(r[k], v) > 0), q),
    lte: (k: string, v: any) => (filters.push((r) => r[k] != null && cmp(r[k], v) <= 0), q),
    lt: (k: string, v: any) => (filters.push((r) => r[k] != null && cmp(r[k], v) < 0), q),
    is: (k: string, v: any) => (filters.push((r) => (v === null ? r[k] == null : r[k] === v)), q),
    or: (expr: string) => ((orExpr = expr), filters.push(parseOr(expr)), q),
    order: (col: string, o?: { ascending?: boolean }) => (orders.push({ col, asc: o?.ascending ?? true }), q),
    limit: (n: number) => ((limit = n), q),
    range: (a: number, b: number) => {
      rangeFrom = a;
      rangeTo = b;
      usedRange = true;
      return q;
    },
    single: async () => {
      const r = exec();
      if (r.error) return r;
      const d = r.data as Row[] | null;
      if (!d || d.length !== 1) return { data: null, error: { message: `single(): ${d?.length ?? 0} rows` }, count: null };
      return { ...r, data: d[0] };
    },
    maybeSingle: async () => {
      const r = exec();
      return { ...r, data: (r.data as Row[] | null)?.[0] ?? null };
    },
    then: (res: any, rej: any) => {
      try {
        return Promise.resolve(exec()).then(res, rej);
      } catch (e) {
        return Promise.reject(e).then(res, rej);
      }
    },
  };
  return q;
}

export const sweepDbClient = { from: (t: string) => query(t) };
