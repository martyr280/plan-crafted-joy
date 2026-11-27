import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { AlertTriangle, DollarSign, Download, Loader2, Package, Percent, RotateCcw, TrendingDown, Undo2, X } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { useModuleView } from "@/lib/usage-log";
import { useRmaReport } from "@/hooks/useRmaReport";
import {
  applyFilters, causeOf, FILTER_LABELS, groupBy, hasSalesBase, isAboveAverage, lastFullMonths, monthsBetween,
  ORDER_ENTRY_REASONS, reasonOf, returnPct, salesBase, toCsv, totals, CAUSE_BY_REASON, OTHER_CAUSE,
  type Filter, type FilterKind, type Group, type RmaLine, type RmaSalesRow,
} from "@/lib/rma-report/aggregate";

export const Route = createFileRoute("/_app/rma-report")({
  head: () => ({
    meta: [
      { title: "RMA Report — Nelson AI for NDI" },
      { name: "description", content: "Returns by customer, route, product group, item and reason, with return % on inventory sales." },
      { property: "og:title", content: "RMA Report — Nelson AI for NDI" },
      { property: "og:description", content: "Returns by customer, route, product group, item and reason, with return % on inventory sales." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RmaReportPage,
});

const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = (v: number) => v.toLocaleString("en-US");
const pctTxt = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const CAUSES = [...new Set([...Object.values(CAUSE_BY_REASON), OTHER_CAUSE])];
const CAUSE_COLORS = ["var(--primary)", "var(--destructive)", "var(--warning)", "var(--chart-4, var(--accent-foreground))", "var(--chart-5, var(--secondary-foreground))", "var(--success-text, var(--primary))", "var(--muted-foreground)"];
const NO_BASE = "No sales base for this filter";

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, 1)).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function RmaReportPage() {
  useModuleView("rma-report");
  const def = lastFullMonths(3);
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);
  const [includeRts, setIncludeRts] = useState(true);
  const [filters, setFilters] = useState<Filter[]>([]);
  const { months, run, retry } = useRmaReport();

  const nMonths = from && to && from <= to ? monthsBetween(from, to) : 0;
  const rangeError = !from || !to ? "Pick both dates." : from > to ? "From must be on or before To." : nMonths > 24 ? "Maximum range is 24 months." : null;
  const busy = months.some((m) => m.status === "loading" || m.status === "pending");
  const done = months.filter((m) => m.status === "done");
  const failed = months.filter((m) => m.status === "error");
  const complete = months.length > 0 && done.length === months.length;

  const allLines = useMemo<RmaLine[]>(() => (complete ? done.flatMap((m) => m.lines ?? []) : []), [complete, done]);
  const allSales = useMemo<RmaSalesRow[]>(() => (complete ? done.flatMap((m) => m.sales ?? []) : []), [complete, done]);
  const salesByMonth = useMemo(() => {
    const o: Record<string, number> = {};
    if (complete) for (const m of done) o[m.month] = salesBase(m.sales ?? [], filters) ?? 0;
    return o;
  }, [complete, done, filters]);

  const lines = useMemo(() => applyFilters(allLines, filters, includeRts), [allLines, filters, includeRts]);
  const t = useMemo(() => totals(lines), [lines]);
  const base = useMemo(() => salesBase(allSales, filters), [allSales, filters]);
  const overallPct = returnPct(t.returnCost, base);
  const baseOk = hasSalesBase(filters);
  // Sales restricted to filtered customer/product group, for per-row Return % inside groups.
  const scopedSales = useMemo(() => {
    const cust = filters.find((f) => f.kind === "customer")?.value;
    const pg = filters.find((f) => f.kind === "productGroup")?.value;
    return allSales.filter((r) => (!cust || String(r.customer_id ?? "").trim() === cust) && (!pg || String(r.product_group_id ?? "").trim() === pg));
  }, [allSales, filters]);

  const addFilter = (kind: FilterKind, g: Group) => {
    if (filters.some((f) => f.kind === kind)) setFilters((fs) => fs.map((f) => (f.kind === kind ? { kind, value: g.key, label: g.label || "(blank)" } : f)));
    else setFilters((fs) => [...fs, { kind, value: g.key, label: g.label || "(blank)" }]);
  };

  const preset = (n: number) => { const r = lastFullMonths(n); setFrom(r.from); setTo(r.to); };

  return (
    <TooltipProvider>
      <div>
        <ModuleHeader
          title="RMA Report"
          description="Returns by invoice date, with return % on inventory sales, matching NDI's RMA workbook."
          actions={<Button asChild variant="outline" size="sm"><Link to="/rma-analytics">RMA Analytics</Link></Button>}
        />

        <Card className="p-4 mb-6">
          <div className="flex flex-wrap items-end gap-3">
            <div><Label htmlFor="rr-from">From</Label><Input id="rr-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /></div>
            <div><Label htmlFor="rr-to">To</Label><Input id="rr-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>
            {[3, 6, 12].map((n) => <Button key={n} variant="outline" size="sm" onClick={() => preset(n)}>Last {n} months</Button>)}
            <Button onClick={() => { setFilters([]); void run(from, to); }} disabled={!!rangeError || busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}Run report
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              <Switch id="rr-rts" checked={includeRts} onCheckedChange={setIncludeRts} />
              <Label htmlFor="rr-rts">Include return to stock</Label>
            </div>
          </div>
          {rangeError && <p className="text-sm text-destructive mt-2">{rangeError}</p>}
          {months.length > 0 && (
            <div className="mt-3 text-sm space-y-2">
              <p className="text-muted-foreground">Pulled {done.length} of {months.length} months</p>
              {failed.map((m) => (
                <div key={m.month} className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <span>{monthLabel(m.month)} failed: {m.error}</span>
                  <Button size="sm" variant="outline" onClick={() => retry(m.month)}><RotateCcw className="h-3 w-3 mr-1" />Retry</Button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {months.length === 0 && <Card className="p-8 text-center text-muted-foreground">Pick a date range and choose Run report.</Card>}

        {months.length > 0 && !complete && (
          <Card className="p-8 text-center text-muted-foreground">
            {failed.length > 0
              ? <>Totals incomplete: missing {failed.map((m) => monthLabel(m.month)).join(", ")}.</>
              : <><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Pulling from P21…</>}
          </Card>
        )}

        {complete && (
          <>
            {filters.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-4">
                {filters.map((f) => (
                  <Badge key={f.kind} variant="secondary" className="gap-1">
                    {FILTER_LABELS[f.kind]}: {f.label}
                    <button aria-label={`Remove ${FILTER_LABELS[f.kind]} filter`} onClick={() => setFilters((fs) => fs.filter((x) => x.kind !== f.kind))}><X className="h-3 w-3" /></button>
                  </Badge>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setFilters([])}>Clear filters</Button>
              </div>
            )}

            <div className="grid gap-4 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-6">
              <KpiCard label="Return lines" value={int(t.lines)} icon={<Undo2 className="h-5 w-5" />} />
              <KpiCard label="Return sales" value={usd(t.returnSales)} icon={<DollarSign className="h-5 w-5" />} />
              <KpiCard label="Return cost" value={usd(t.returnCost)} icon={<Package className="h-5 w-5" />} />
              <KpiCard label="Margin lost" value={usd(t.marginLost)} icon={<TrendingDown className="h-5 w-5" />} />
              <Tooltip>
                <TooltipTrigger asChild><div><KpiCard label="Return %" value={pctTxt(overallPct)} icon={<Percent className="h-5 w-5" />} /></div></TooltipTrigger>
                <TooltipContent>{baseOk ? "Return cost divided by inventory sales, same formula as NDI's workbook" : NO_BASE}</TooltipContent>
              </Tooltip>
              <KpiCard label="Return-to-stock share" value={pctTxt(t.lines ? t.rtsLines / t.lines : null)} sub="of return lines" icon={<RotateCcw className="h-5 w-5" />} />
            </div>

            <Tabs defaultValue="customers">
              <TabsList className="flex-wrap h-auto">
                {["Customers", "Route", "Manufacturer", "Product Group", "Items", "Return Reasons", "Return Trend", "Order Entry Errors", "Detail"].map((x) => (
                  <TabsTrigger key={x} value={x.toLowerCase().replace(/ /g, "-")}>{x}</TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="customers"><CustomersTab lines={lines} sales={scopedSales} overallPct={overallPct} baseOk={baseOk} onPick={(g) => addFilter("customer", g)} /></TabsContent>
              <TabsContent value="route"><RouteTab lines={lines} onPick={(g) => addFilter("route", g)} /></TabsContent>
              <TabsContent value="manufacturer"><ManufacturerTab lines={lines} onPick={(g) => addFilter("manufacturer", g)} /></TabsContent>
              <TabsContent value="product-group"><ProductGroupTab lines={lines} sales={scopedSales} baseOk={baseOk} onPick={(g) => addFilter("productGroup", g)} /></TabsContent>
              <TabsContent value="items"><ItemsTab lines={lines} onPick={(g) => addFilter("item", g)} /></TabsContent>
              <TabsContent value="return-reasons"><ReasonsTab lines={lines} onPick={(g) => addFilter("reason", g)} /></TabsContent>
              <TabsContent value="return-trend"><TrendTab lines={lines} salesByMonth={salesByMonth} baseOk={baseOk} /></TabsContent>
              <TabsContent value="order-entry-errors"><OeeTab lines={lines} /></TabsContent>
              <TabsContent value="detail"><DetailTab lines={lines} from={from} to={to} /></TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

function PctCell({ v, baseOk }: { v: number | null; baseOk: boolean }) {
  if (baseOk) return <TableCell className="text-right">{pctTxt(v)}</TableCell>;
  return (
    <TableCell className="text-right">
      <Tooltip><TooltipTrigger asChild><span>—</span></TooltipTrigger><TooltipContent>{NO_BASE}</TooltipContent></Tooltip>
    </TableCell>
  );
}

function ClickRow({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <TableRow className="cursor-pointer hover:bg-accent/50" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === "Enter") onClick(); }}>
      {children}
    </TableRow>
  );
}

const R = ({ children }: { children: React.ReactNode }) => <TableHead className="text-right">{children}</TableHead>;
const C = ({ children }: { children: React.ReactNode }) => <TableCell className="text-right">{children}</TableCell>;

function CustomersTab({ lines, sales, overallPct, baseOk, onPick }: { lines: RmaLine[]; sales: RmaSalesRow[]; overallPct: number | null; baseOk: boolean; onPick: (g: Group) => void }) {
  const rows = useMemo(() => groupBy(lines, "customer", { sales }), [lines, sales]);
  return (
    <Card className="p-0 overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Customer</TableHead><R>Sales</R><R>Return sales</R><R>Return cost</R><R>Margin lost</R><R>Qty</R><R>Lines</R><R>Return %</R></TableRow></TableHeader>
        <TableBody>
          {rows.map((g) => (
            <ClickRow key={g.key} onClick={() => onPick(g)}>
              <TableCell>{g.label} <span className="text-xs text-muted-foreground">{g.key}</span>
                {baseOk && isAboveAverage(g, overallPct) && <Badge variant="destructive" className="ml-2">Above average</Badge>}</TableCell>
              <C>{g.sales == null ? "—" : usd(g.sales)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C><C>{usd(g.marginLost)}</C><C>{int(g.qty)}</C><C>{int(g.lines)}</C>
              <PctCell v={g.returnPct} baseOk={baseOk} />
            </ClickRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function RouteTab({ lines, onPick }: { lines: RmaLine[]; onPick: (g: Group) => void }) {
  const rows = useMemo(() => groupBy(lines, "route"), [lines]);
  return (
    <Card className="p-0 overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Route</TableHead><R>Lines</R><R>Qty</R><R>Return sales</R><R>Return cost</R><TableHead>Top reason</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((g) => (
          <ClickRow key={g.key} onClick={() => onPick({ ...g, label: g.key || "(no route)" })}>
            <TableCell>{g.key || "(no route)"}</TableCell><C>{int(g.lines)}</C><C>{int(g.qty)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C><TableCell>{g.topReason}</TableCell>
          </ClickRow>
        ))}</TableBody>
      </Table>
    </Card>
  );
}

function ManufacturerTab({ lines, onPick }: { lines: RmaLine[]; onPick: (g: Group) => void }) {
  const rows = useMemo(() => groupBy(lines, "manufacturer"), [lines]);
  if (rows.length > 0 && rows.every((g) => !g.key)) return <Card className="p-6 text-muted-foreground">P21 has no manufacturer on these items.</Card>;
  return (
    <Card className="p-0 overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Manufacturer</TableHead><R>Lines</R><R>Qty</R><R>Return sales</R><R>Return cost</R><TableHead>Top reason</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((g) => (
          <ClickRow key={g.key} onClick={() => onPick({ ...g, label: g.key || "(none in P21)" })}>
            <TableCell>{g.key || "(none in P21)"}</TableCell><C>{int(g.lines)}</C><C>{int(g.qty)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C><TableCell>{g.topReason}</TableCell>
          </ClickRow>
        ))}</TableBody>
      </Table>
    </Card>
  );
}

function ProductGroupTab({ lines, sales, baseOk, onPick }: { lines: RmaLine[]; sales: RmaSalesRow[]; baseOk: boolean; onPick: (g: Group) => void }) {
  const rows = useMemo(() => groupBy(lines, "productGroup", { sales }), [lines, sales]);
  return (
    <Card className="p-0 overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Product group</TableHead><R>Sales</R><R>Return sales</R><R>Return cost</R><R>Lines</R><R>Return %</R></TableRow></TableHeader>
        <TableBody>{rows.map((g) => (
          <ClickRow key={g.key} onClick={() => onPick({ ...g, label: g.key || "(none)" })}>
            <TableCell>{g.key || "(none)"} <span className="text-xs text-muted-foreground">{g.extra}</span></TableCell>
            <C>{g.sales == null ? "—" : usd(g.sales)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C><C>{int(g.lines)}</C>
            <PctCell v={g.returnPct} baseOk={baseOk} />
          </ClickRow>
        ))}</TableBody>
      </Table>
    </Card>
  );
}

function ItemsTab({ lines, onPick }: { lines: RmaLine[]; onPick: (g: Group) => void }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const all = groupBy(lines, "item");
    const s = q.trim().toLowerCase();
    return (s ? all.filter((g) => g.key.toLowerCase().includes(s) || g.extra.toLowerCase().includes(s)) : all).slice(0, 200);
  }, [lines, q]);
  return (
    <Card className="p-0 overflow-x-auto">
      <div className="p-3"><Input placeholder="Search item or description" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" aria-label="Search items" /></div>
      <Table>
        <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Description</TableHead><TableHead>Product group</TableHead><R>Lines</R><R>Qty</R><R>Return sales</R><R>Return cost</R><TableHead>Top reason</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((g) => {
          const pg = lines.find((l) => String(l.item_id ?? "").trim() === g.key)?.product_group_id ?? "";
          return (
            <ClickRow key={g.key} onClick={() => onPick(g)}>
              <TableCell className="font-mono text-xs">{g.key}</TableCell><TableCell>{g.extra}</TableCell><TableCell>{pg}</TableCell>
              <C>{int(g.lines)}</C><C>{int(g.qty)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C><TableCell>{g.topReason}</TableCell>
            </ClickRow>
          );
        })}</TableBody>
      </Table>
      <p className="p-3 text-xs text-muted-foreground">Top 200 by return cost.</p>
    </Card>
  );
}

function ReasonsTab({ lines, onPick }: { lines: RmaLine[]; onPick: (g: Group) => void }) {
  const rows = useMemo(() => groupBy(lines, "reason"), [lines]);
  const total = lines.length || 1;
  return (
    <Card className="p-0 overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Reason</TableHead><TableHead>Cause</TableHead><R>Lines</R><R>Qty</R><R>Return sales</R><R>Return cost</R><R>Share of lines</R></TableRow></TableHeader>
        <TableBody>{rows.map((g) => (
          <ClickRow key={g.key} onClick={() => onPick(g)}>
            <TableCell>{g.key}</TableCell><TableCell>{g.extra}</TableCell><C>{int(g.lines)}</C><C>{int(g.qty)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C><C>{pctTxt(g.lines / total)}</C>
          </ClickRow>
        ))}</TableBody>
      </Table>
      <p className="p-3 text-xs text-muted-foreground">Cause grouping is proposed and still to be confirmed with NDI.</p>
    </Card>
  );
}

function TrendTab({ lines, salesByMonth, baseOk }: { lines: RmaLine[]; salesByMonth: Record<string, number>; baseOk: boolean }) {
  const rows = useMemo(() => groupBy(lines, "month", { salesByMonth }).sort((a, b) => a.key.localeCompare(b.key)), [lines, salesByMonth]);
  const chart = rows.map((g) => ({ month: monthLabel(g.key), ...Object.fromEntries(CAUSES.map((c) => [c, g.causes[c] ?? 0])) }));
  return (
    <div className="space-y-4">
      <Card className="p-4 h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="month" /><YAxis allowDecimals={false} /><RTooltip /><Legend />
            {CAUSES.map((c, i) => <Bar key={c} dataKey={c} stackId="a" fill={CAUSE_COLORS[i % CAUSE_COLORS.length]} />)}
          </BarChart>
        </ResponsiveContainer>
      </Card>
      <Card className="p-0 overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Month</TableHead><R>Lines</R><R>Return sales</R><R>Return %</R></TableRow></TableHeader>
          <TableBody>{rows.map((g) => (
            <TableRow key={g.key}><TableCell>{monthLabel(g.key)}</TableCell><C>{int(g.lines)}</C><C>{usd(g.returnSales)}</C><PctCell v={g.returnPct} baseOk={baseOk} /></TableRow>
          ))}</TableBody>
        </Table>
      </Card>
    </div>
  );
}

function OeeTab({ lines }: { lines: RmaLine[] }) {
  const oee = useMemo(() => lines.filter((l) => ORDER_ENTRY_REASONS.includes(reasonOf(l))), [lines]);
  const byType = useMemo(() => groupBy(oee, "reason"), [oee]);
  const byCust = useMemo(() => groupBy(oee, "customer"), [oee]);
  const byItem = useMemo(() => groupBy(oee, "item").slice(0, 200), [oee]);
  if (oee.length === 0) return <Card className="p-6 text-muted-foreground">No Order Entry Error or Mispull lines in this range.</Card>;
  const Mini = ({ title, rows, desc }: { title: string; rows: Group[]; desc?: boolean }) => (
    <Card className="p-0 overflow-x-auto">
      <p className="p-3 font-medium">{title}</p>
      <Table>
        <TableHeader><TableRow><TableHead>{title.replace("By ", "")}</TableHead><R>Lines</R><R>Qty</R><R>Return sales</R><R>Return cost</R></TableRow></TableHeader>
        <TableBody>{rows.map((g) => (
          <TableRow key={g.key}><TableCell>{g.label}{desc && g.extra ? <span className="text-xs text-muted-foreground"> {g.extra}</span> : null}</TableCell><C>{int(g.lines)}</C><C>{int(g.qty)}</C><C>{usd(g.returnSales)}</C><C>{usd(g.returnCost)}</C></TableRow>
        ))}</TableBody>
      </Table>
    </Card>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Mini title="By type" rows={byType} /><Mini title="By customer" rows={byCust} /><Mini title="By item" rows={byItem} desc />
    </div>
  );
}

function DetailTab({ lines, from, to }: { lines: RmaLine[]; from: string; to: string }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return lines;
    return lines.filter((l) => [l.invoice_no, l.order_no, l.customer_id, l.customer_name, l.item_id, l.item_desc, l.route_code, l.return_reason].some((v) => String(v ?? "").toLowerCase().includes(s)));
  }, [lines, q]);
  const exportCsv = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `rma-report-${from}-to-${to}.csv`; a.click();
    URL.revokeObjectURL(a.href);
  };
  const shown = rows.slice(0, 1000);
  return (
    <Card className="p-0 overflow-x-auto">
      <div className="p-3 flex gap-2 items-center">
        <Input placeholder="Search invoice, order, customer, item, route, reason" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" aria-label="Search detail" />
        <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />Export CSV</Button>
        <span className="text-xs text-muted-foreground ml-auto">{int(rows.length)} lines{rows.length > shown.length ? `, showing first ${int(shown.length)} (export has all)` : ""}</span>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>Invoice date</TableHead><TableHead>Invoice</TableHead><TableHead>Order</TableHead><TableHead>Customer</TableHead><TableHead>Item</TableHead><TableHead>Route</TableHead><TableHead>Reason</TableHead><TableHead>Cause</TableHead><R>Qty</R><R>Return sales</R><R>Return cost</R></TableRow></TableHeader>
        <TableBody>{shown.map((l, i) => (
          <TableRow key={`${l.invoice_no}-${l.item_id}-${i}`}>
            <TableCell>{l.invoice_date}</TableCell><TableCell>{l.invoice_no}</TableCell><TableCell>{l.order_no}</TableCell><TableCell>{l.customer_name}</TableCell>
            <TableCell className="font-mono text-xs">{l.item_id}</TableCell><TableCell>{l.route_code}</TableCell><TableCell>{reasonOf(l)}</TableCell><TableCell>{causeOf(reasonOf(l))}</TableCell>
            <C>{int(Number(l.qty) || 0)}</C><C>{usd(Number(l.return_sales) || 0)}</C><C>{usd(Number(l.return_cost) || 0)}</C>
          </TableRow>
        ))}</TableBody>
      </Table>
    </Card>
  );
}
