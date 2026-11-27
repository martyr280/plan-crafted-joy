// Pure RMA Report aggregation. No server imports.
export interface RmaLine {
  invoice_no: string | number; invoice_date: string; order_no: string | number | null;
  customer_id: string | number | null; customer_name: string | null; sales_location_id: string | number | null;
  item_id: string | null; item_desc: string | null; product_group_id: string | null; product_group_desc: string | null;
  manufacturer_name: string | null; route_code: string | null;
  qty: number | string; return_sales: number | string; return_cost: number | string; return_reason: string | null;
}
export interface RmaSalesRow { customer_id: string | number | null; customer_name: string | null; product_group_id: string | null; sales: number | string; }
export interface MonthSales { month: string; rows: RmaSalesRow[] }

export const RETURN_TO_STOCK = "Return to Stock";

/** Proposed grouping, confirm with NDI. */
export const CAUSE_BY_REASON: Record<string, string> = {
  "Return to Stock": "Customer return",
  "Damage Returns": "Our damage",
  "Warehouse Damage": "Our damage",
  "LTL Damage": "Carrier damage",
  "Factory Defect": "Product defect",
  "Order Entry Error": "Keying error",
  "Mispull": "Picking error",
};
export const OTHER_CAUSE = "Other";
export const ORDER_ENTRY_REASONS = ["Order Entry Error", "Mispull"];

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const s = (v: unknown) => (v == null ? "" : String(v).trim());
export function reasonOf(l: RmaLine) { return s(l.return_reason) || RETURN_TO_STOCK; }
export function causeOf(reason: string) { return CAUSE_BY_REASON[reason] ?? OTHER_CAUSE; }
export function monthOf(l: RmaLine) { return s(l.invoice_date).slice(0, 7); }

export type FilterKind = "customer" | "route" | "manufacturer" | "productGroup" | "item" | "reason";
export interface Filter { kind: FilterKind; value: string; label: string }
export const FILTER_LABELS: Record<FilterKind, string> = {
  customer: "Customer", route: "Route", manufacturer: "Manufacturer", productGroup: "Product group", item: "Item", reason: "Reason",
};

export function keyOf(l: RmaLine, kind: FilterKind | "cause" | "month"): string {
  switch (kind) {
    case "customer": return s(l.customer_id);
    case "route": return s(l.route_code);
    case "manufacturer": return s(l.manufacturer_name);
    case "productGroup": return s(l.product_group_id);
    case "item": return s(l.item_id);
    case "reason": return reasonOf(l);
    case "cause": return causeOf(reasonOf(l));
    case "month": return monthOf(l);
  }
}

export function applyFilters(lines: RmaLine[], filters: Filter[], includeRts: boolean): RmaLine[] {
  return lines.filter((l) => {
    if (!includeRts && reasonOf(l) === RETURN_TO_STOCK) return false;
    for (const f of filters) if (keyOf(l, f.kind) !== f.value) return false;
    return true;
  });
}

/** Sales base exists only for customer / product-group filters (or none). */
export function hasSalesBase(filters: Filter[]) {
  return filters.every((f) => f.kind === "customer" || f.kind === "productGroup");
}

export function salesBase(sales: RmaSalesRow[], filters: Filter[]): number | null {
  if (!hasSalesBase(filters)) return null;
  const cust = filters.filter((f) => f.kind === "customer").map((f) => f.value);
  const pg = filters.filter((f) => f.kind === "productGroup").map((f) => f.value);
  let t = 0;
  for (const r of sales) {
    if (cust.length && !cust.every((c) => c === s(r.customer_id))) continue;
    if (pg.length && !pg.every((p) => p === s(r.product_group_id))) continue;
    t += n(r.sales);
  }
  return t;
}

export interface Totals { lines: number; qty: number; returnSales: number; returnCost: number; marginLost: number; rtsLines: number }
export function totals(lines: RmaLine[]): Totals {
  const t: Totals = { lines: 0, qty: 0, returnSales: 0, returnCost: 0, marginLost: 0, rtsLines: 0 };
  for (const l of lines) {
    t.lines++; t.qty += n(l.qty); t.returnSales += n(l.return_sales); t.returnCost += n(l.return_cost);
    if (reasonOf(l) === RETURN_TO_STOCK) t.rtsLines++;
  }
  t.marginLost = t.returnSales - t.returnCost;
  return t;
}
export function returnPct(cost: number, sales: number | null): number | null {
  return sales && sales > 0 ? cost / sales : null;
}

export interface Group extends Totals { key: string; label: string; topReason: string; extra: string; sales: number | null; returnPct: number | null; causes: Record<string, number> }

export function groupBy(
  lines: RmaLine[], kind: FilterKind | "cause" | "month",
  opts: { sales?: RmaSalesRow[]; salesByMonth?: Record<string, number> } = {},
): Group[] {
  const m = new Map<string, RmaLine[]>();
  for (const l of lines) { const k = keyOf(l, kind); const a = m.get(k); if (a) a.push(l); else m.set(k, [l]); }
  const salesByKey = new Map<string, number>();
  if (opts.sales && (kind === "customer" || kind === "productGroup")) {
    for (const r of opts.sales) {
      const k = kind === "customer" ? s(r.customer_id) : s(r.product_group_id);
      salesByKey.set(k, (salesByKey.get(k) ?? 0) + n(r.sales));
    }
  }
  const out: Group[] = [];
  for (const [key, ls] of m) {
    const t = totals(ls);
    const rc = new Map<string, number>(); const causes: Record<string, number> = {};
    for (const l of ls) { const r = reasonOf(l); rc.set(r, (rc.get(r) ?? 0) + 1); const c = causeOf(r); causes[c] = (causes[c] ?? 0) + 1; }
    const topReason = [...rc.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
    const first = ls[0]!;
    let label = key, extra = "";
    if (kind === "customer") label = s(first.customer_name) || key;
    if (kind === "productGroup") extra = s(first.product_group_desc);
    if (kind === "item") { extra = s(first.item_desc); label = key; }
    if (kind === "reason") extra = causeOf(key);
    let sales: number | null = null;
    if (kind === "customer" || kind === "productGroup") sales = opts.sales ? (salesByKey.get(key) ?? 0) : null;
    if (kind === "month" && opts.salesByMonth) sales = opts.salesByMonth[key] ?? 0;
    out.push({ ...t, key, label, topReason, extra, sales, returnPct: returnPct(t.returnCost, sales), causes });
  }
  return out.sort((a, b) => b.returnCost - a.returnCost);
}

export function isAboveAverage(g: Group, overallPct: number | null) {
  return overallPct != null && overallPct > 0 && g.returnPct != null && g.lines >= 5 && g.returnPct >= 2 * overallPct;
}

/** Split [from, to] into calendar months, first/last clipped. */
export function splitMonths(from: string, to: string): { month: string; from: string; to: string }[] {
  const out: { month: string; from: string; to: string }[] = [];
  if (from > to) return out;
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  for (;;) {
    const mm = `${y}-${String(m).padStart(2, "0")}`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const f = mm === from.slice(0, 7) ? from : `${mm}-01`;
    const t = mm === to.slice(0, 7) ? to : last;
    out.push({ month: mm, from: f, to: t });
    if (mm >= to.slice(0, 7)) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Last N whole calendar months ending with the month before `today`. */
export function lastFullMonths(nMonths: number, today = new Date()): { from: string; to: string } {
  const y = today.getUTCFullYear(), m = today.getUTCMonth();
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const from = new Date(Date.UTC(y, m - nMonths, 1)).toISOString().slice(0, 10);
  return { from, to };
}

export function monthsBetween(from: string, to: string) { return splitMonths(from, to).length; }

export function toCsv(lines: RmaLine[]): string {
  const cols: (keyof RmaLine)[] = ["invoice_no", "invoice_date", "order_no", "customer_id", "customer_name", "sales_location_id", "item_id", "item_desc", "product_group_id", "product_group_desc", "manufacturer_name", "route_code", "qty", "return_sales", "return_cost", "return_reason"];
  const esc = (v: unknown) => { const x = v == null ? "" : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  return [[...cols, "cause"].join(","), ...lines.map((l) => [...cols.map((c) => esc(l[c])), esc(causeOf(reasonOf(l)))].join(","))].join("\n");
}
