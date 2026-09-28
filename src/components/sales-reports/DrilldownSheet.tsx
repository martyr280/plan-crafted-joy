import { useMemo, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, FileDown } from "lucide-react";
import { useSalesReportDrilldown } from "@/hooks/useSalesReports";
import { toCsv, type DrilldownKind, type DrillRow, type DrillRepRow } from "@/lib/sales-reports.drilldown";

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v < 0 ? `($${Math.abs(Math.round(v)).toLocaleString()})` : `$${Math.round(v).toLocaleString()}`;
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "" : `${(v * 100).toFixed(1)}%`);
const margin = (p: number, s: number) => (s === 0 ? null : p / s);

type Col<T> = {
  key: string;
  label: string;
  num?: boolean;
  value: (r: T) => string | number | null;
  fmt?: (v: any) => string;
  /** Footer: "sum" of value, or a function over the filtered rows. */
  foot?: "sum" | ((rows: T[]) => string);
  rep?: boolean;
};

function DrillTable<T extends { rep_code: string; rep_name: string }>({
  rows, cols, defaultSort, searchText, onRep, filename,
}: {
  rows: T[]; cols: Col<T>[]; defaultSort: string; searchText: (r: T) => string;
  onRep: (rep: string) => void; filename: string;
}) {
  const [q, setQ] = useState("");
  const [rep, setRep] = useState("all");
  const [sort, setSort] = useState(defaultSort);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const repOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.rep_code, r.rep_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const col = cols.find((c) => c.key === sort) ?? cols[0];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter((r) => (rep === "all" || r.rep_code === rep) && (!needle || searchText(r).toLowerCase().includes(needle)));
    out.sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      let c: number;
      if (typeof av === "number" || typeof bv === "number") c = (av as number ?? -Infinity) - (bv as number ?? -Infinity);
      else c = String(av ?? "").localeCompare(String(bv ?? ""));
      return dir === "asc" ? c : -c;
    });
    return out;
  }, [rows, q, rep, col, dir, searchText]);
  const click = (k: string) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(k); setDir(cols.find((c) => c.key === k)?.num ? "desc" : "asc"); }
  };
  const show = (c: Col<T>, r: T) => { const v = c.value(r); return c.fmt ? c.fmt(v) : v === null ? "" : String(v); };
  const footOf = (c: Col<T>) => {
    if (!c.foot) return "";
    if (c.foot === "sum") { const s = filtered.reduce((a, r) => a + ((c.value(r) as number) ?? 0), 0); return c.fmt ? c.fmt(s) : String(s); }
    return c.foot(filtered);
  };
  const exportCsv = () => {
    const csv = toCsv(cols.map((c) => c.label), filtered.map((r) => cols.map((c) => c.value(r))));
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Input placeholder="Search customer, code, city, rep" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Select value={rep} onValueChange={setRep}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All reps</SelectItem>
            {repOpts.map(([code, name]) => <SelectItem key={code} value={code}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{filtered.length.toLocaleString()} shown</span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv}><FileDown className="w-4 h-4 mr-1" /> Export CSV</Button>
      </div>
      <div className="border rounded-md overflow-auto max-h-[65vh]">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((c) => (
                <TableHead key={c.key} className={c.num ? "text-right" : ""}>
                  <button type="button" onClick={() => click(c.key)} className="inline-flex items-center gap-1 hover:text-foreground">
                    {c.label}
                    {sort === c.key && (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r, i) => (
              <TableRow key={i}>
                {cols.map((c) => (
                  <TableCell key={c.key} className={c.num ? "text-right tabular-nums" : ""}>
                    {c.rep ? (
                      <button type="button" className="text-primary hover:underline" onClick={() => onRep(r.rep_code)}>{show(c, r)}</button>
                    ) : show(c, r)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              {cols.map((c, i) => (
                <TableCell key={c.key} className={`font-semibold ${c.num ? "text-right tabular-nums" : ""}`}>{i === 0 ? "Total" : footOf(c)}</TableCell>
              ))}
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}

const custSearch = (r: DrillRow) => `${r.customer_name ?? ""} ${r.cust_code} ${r.city ?? ""} ${r.rep_name}`;
const repSearch = (r: DrillRepRow) => r.rep_name;
const cnt = (rows: unknown[]) => rows.length.toLocaleString();

export const DRILL_LABELS = (monthLabel: string): Record<DrilldownKind, string> => ({
  ytd: "YTD sales (all reps)",
  month: `${monthLabel} sales`,
  at_risk: "Keep-level at risk",
  win_back: "Win-back candidates",
});

export function DrilldownSheet({
  kind, runId, monthLabel, onClose, onRep,
}: {
  kind: DrilldownKind | null; runId: string | null; monthLabel: string;
  onClose: () => void; onRep: (rep: string, kind: DrilldownKind) => void;
}) {
  const q = useSalesReportDrilldown(runId, kind);
  const d = q.data;
  const label = kind ? DRILL_LABELS(monthLabel)[kind] : "";
  const period = d?.run ? `${d.monthLabel} ${d.run.period_year}` : "";
  const isMoney = kind === "ytd" || kind === "month";
  const rep = (code: string) => kind && onRep(code, kind);
  const file = (s: string) => `sales-${kind}-${s}-${period.replace(/\s/g, "-")}.csv`;

  let body: ReactNode = null;
  if (d && kind === "ytd") {
    const totalYtd = d.total;
    const repCols: Col<DrillRepRow>[] = [
      { key: "rep", label: "Rep", value: (r) => r.rep_name, rep: true },
      { key: "customers", label: "Customers", num: true, value: (r) => r.customers, foot: "sum" },
      { key: "ytd", label: "YTD", num: true, value: (r) => r.ytd, fmt: money, foot: "sum" },
      { key: "share", label: "Share %", num: true, value: (r) => (totalYtd ? r.ytd / totalYtd : null), fmt: pct, foot: (rs) => pct(totalYtd ? rs.reduce((a, r) => a + r.ytd, 0) / totalYtd : null) },
      { key: "ann", label: "Annualized", num: true, value: (r) => r.annualized, fmt: money, foot: "sum" },
      { key: "pct", label: "vs prior yr", num: true, value: (r) => r.pct_vs_prior, fmt: pct },
    ];
    const custCols: Col<DrillRow>[] = [
      { key: "code", label: "Cust Code", value: (r) => r.cust_code, foot: cnt },
      { key: "name", label: "Customer Name", value: (r) => r.customer_name },
      { key: "city", label: "City", value: (r) => r.city },
      { key: "st", label: "St", value: (r) => r.state },
      { key: "rep", label: "Rep", value: (r) => r.rep_name, rep: true },
      { key: "ytd", label: "YTD", num: true, value: (r) => r.y_current, fmt: money, foot: "sum" },
      { key: "ann", label: "Ann", num: true, value: (r) => r.ann_current, fmt: money, foot: "sum" },
      { key: "pct", label: "Pct", num: true, value: (r) => r.pct, fmt: pct },
      { key: "y2025", label: "2025", num: true, value: (r) => r.y2025, fmt: money, foot: "sum" },
    ];
    body = (
      <Tabs defaultValue="rep">
        <TabsList><TabsTrigger value="rep">By rep</TabsTrigger><TabsTrigger value="cust">By customer</TabsTrigger></TabsList>
        <TabsContent value="rep"><DrillTable rows={d.reps} cols={repCols} defaultSort="ytd" searchText={repSearch} onRep={rep} filename={file("by-rep")} /></TabsContent>
        <TabsContent value="cust"><DrillTable rows={d.rows} cols={custCols} defaultSort="ytd" searchText={custSearch} onRep={rep} filename={file("by-customer")} /></TabsContent>
      </Tabs>
    );
  } else if (d && kind === "month") {
    const repCols: Col<DrillRepRow>[] = [
      { key: "rep", label: "Rep", value: (r) => r.rep_name, rep: true },
      { key: "ms", label: "Month Sales", num: true, value: (r) => r.month_sales, fmt: money, foot: "sum" },
      { key: "mp", label: "Month Profit", num: true, value: (r) => r.month_profit, fmt: money, foot: "sum" },
      { key: "mg", label: "Margin %", num: true, value: (r) => margin(r.month_profit, r.month_sales), fmt: pct, foot: (rs) => pct(margin(rs.reduce((a, r) => a + r.month_profit, 0), rs.reduce((a, r) => a + r.month_sales, 0))) },
      { key: "ac", label: "Active customers", num: true, value: (r) => r.active_customers, foot: "sum" },
    ];
    const custCols: Col<DrillRow>[] = [
      { key: "code", label: "Cust Code", value: (r) => r.cust_code, foot: cnt },
      { key: "name", label: "Customer Name", value: (r) => r.customer_name },
      { key: "city", label: "City", value: (r) => r.city },
      { key: "st", label: "St", value: (r) => r.state },
      { key: "rep", label: "Rep", value: (r) => r.rep_name, rep: true },
      { key: "ms", label: "Month Sales", num: true, value: (r) => r.month_sales, fmt: money, foot: "sum" },
      { key: "mp", label: "Month Profit", num: true, value: (r) => r.month_profit, fmt: money, foot: "sum" },
      { key: "mg", label: "Margin %", num: true, value: (r) => margin(r.month_profit, r.month_sales), fmt: pct, foot: (rs) => pct(margin(rs.reduce((a, r) => a + r.month_profit, 0), rs.reduce((a, r) => a + r.month_sales, 0))) },
    ];
    body = (
      <Tabs defaultValue="rep">
        <TabsList><TabsTrigger value="rep">By rep</TabsTrigger><TabsTrigger value="cust">By customer</TabsTrigger></TabsList>
        <TabsContent value="rep"><DrillTable rows={d.reps} cols={repCols} defaultSort="ms" searchText={repSearch} onRep={rep} filename={file("by-rep")} /></TabsContent>
        <TabsContent value="cust"><DrillTable rows={d.rows} cols={custCols} defaultSort="ms" searchText={custSearch} onRep={rep} filename={file("by-customer")} /></TabsContent>
      </Tabs>
    );
  } else if (d && kind === "at_risk") {
    const cols: Col<DrillRow>[] = [
      { key: "code", label: "Cust Code", value: (r) => r.cust_code, foot: cnt },
      { key: "name", label: "Customer Name", value: (r) => r.customer_name },
      { key: "rep", label: "Rep", value: (r) => r.rep_name, rep: true },
      { key: "pl", label: "Price level", value: (r) => r.price_level },
      { key: "target", label: "Target", num: true, value: (r) => r.target, fmt: money, foot: "sum" },
      { key: "y2025", label: "2025 sales", num: true, value: (r) => r.y2025, fmt: money, foot: "sum" },
      { key: "ann", label: "Annualized", num: true, value: (r) => r.ann_current, fmt: money, foot: "sum" },
      { key: "gap", label: "Gap to target", num: true, value: (r) => r.gap, fmt: money, foot: "sum" },
      { key: "ytd", label: "YTD", num: true, value: (r) => r.y_current, fmt: money, foot: "sum" },
      { key: "kl", label: "Keep Lvl", value: (r) => r.keep_lvl_code ?? (r.keep_lvl_shortfall === null ? null : money(r.keep_lvl_shortfall)) },
    ];
    body = (
      <Tabs defaultValue="risk">
        <TabsList>
          <TabsTrigger value="risk">At risk ({d.rows.length.toLocaleString()})</TabsTrigger>
          <TabsTrigger value="below">Below target, still buying ({d.belowTarget.length.toLocaleString()})</TabsTrigger>
        </TabsList>
        <TabsContent value="risk">
          <p className="text-sm text-muted-foreground mb-2">Met target in 2025, now pacing below.</p>
          <DrillTable rows={d.rows} cols={cols} defaultSort="gap" searchText={custSearch} onRep={rep} filename={file("at-risk")} />
        </TabsContent>
        <TabsContent value="below">
          <p className="text-sm text-muted-foreground mb-2" data-testid="below-note">Informational. Not counted in the card.</p>
          <DrillTable rows={d.belowTarget} cols={cols} defaultSort="gap" searchText={custSearch} onRep={rep} filename={file("below-target")} />
        </TabsContent>
      </Tabs>
    );
  } else if (d && kind === "win_back") {
    const cols: Col<DrillRow>[] = [
      { key: "code", label: "Cust Code", value: (r) => r.cust_code, foot: cnt },
      { key: "name", label: "Customer Name", value: (r) => r.customer_name },
      { key: "city", label: "City", value: (r) => r.city },
      { key: "st", label: "St", value: (r) => r.state },
      { key: "rep", label: "Rep", value: (r) => r.rep_name, rep: true },
      { key: "y2025", label: "2025 sales", num: true, value: (r) => r.y2025, fmt: money, foot: "sum" },
      { key: "ytd", label: "YTD", num: true, value: (r) => r.y_current, fmt: money, foot: "sum" },
      { key: "tv", label: "Total Value", num: true, value: (r) => r.total_value, fmt: money, foot: "sum" },
    ];
    body = <DrillTable rows={d.rows} cols={cols} defaultSort="y2025" searchText={custSearch} onRep={rep} filename={file("list")} />;
  }

  return (
    <Sheet open={!!kind} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-5xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription data-testid="drill-summary">
            {d ? `${period} · ${d.count.toLocaleString()} rows · Total ${isMoney ? money(d.total) : d.total.toLocaleString()}` : q.isError ? "Could not load details." : "Loading…"}
          </SheetDescription>
          {kind === "win_back" && (
            <p className="text-sm text-muted-foreground">2025 sales of $5,000 or more and no sales in {d?.monthLabel ?? monthLabel}.</p>
          )}
        </SheetHeader>
        <div className="mt-4">{body}</div>
      </SheetContent>
    </Sheet>
  );
}
