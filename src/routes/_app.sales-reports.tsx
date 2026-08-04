import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { KpiCard } from "@/components/shared/KpiCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, ArrowUp, ArrowDown, RefreshCw, FileDown, AlertTriangle, TrendingDown, Undo2, BarChart3 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useModuleView } from "@/lib/usage-log";
import {
  useSalesReportRuns,
  useSalesReportOverview,
  useSalesRepDetail,
  useRunSalesReports,
  useExportRepWorkbook,
} from "@/hooks/useSalesReports";
import { isAtRisk, isDeclining, isWinBack, isKeepLevelExempt, keepThresholdFor, hasPriceLevelMapping, type SalesReportRow, type RepSummary } from "@/lib/sales-reports.shared";

export const Route = createFileRoute("/_app/sales-reports")({
  component: SalesReportsPage,
  head: () => ({
    meta: [
      { title: "Sales Reports · Nelson AI" },
      { name: "description", content: "Live per-salesperson customer scorecards: annualized sales, keep-level risk, declining accounts and win-back candidates." },
      { property: "og:title", content: "Sales Reports · Nelson AI" },
      { property: "og:description", content: "Live per-salesperson customer scorecards replacing the monthly Excel workbooks." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v < 0 ? `($${Math.abs(Math.round(v)).toLocaleString()})` : `$${Math.round(v).toLocaleString()}`;
const pctFmt = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;

function SortHead({
  label, active, dir, onClick, className,
}: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void; className?: string }) {
  return (
    <TableHead className={className}>
      <button type="button" onClick={onClick} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        {active && (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </TableHead>
  );
}

function SalesReportsPage() {
  const { hasRole } = useAuth();
  useModuleView("sales_reports");
  const isAdmin = hasRole("admin");

  const [runId, setRunId] = useState<string | null>(null);
  const [selectedRep, setSelectedRep] = useState<string | null>(null);

  const runs = useSalesReportRuns();
  const overview = useSalesReportOverview(runId);
  const access = overview.data?.access;
  const canManage = !!access?.canManage;
  const repOnly = !canManage && !!access?.repCode;
  const detailRep = canManage ? selectedRep : (access?.repCode ?? null);
  const detail = useSalesRepDetail(runId, detailRep, !!detailRep || repOnly);

  const runList = runs.data?.runs ?? [];
  const activeRun = overview.data?.run ?? detail.data?.run ?? null;
  const monthLabel = overview.data?.monthLabel ?? detail.data?.monthLabel ?? "";

  const runNow = useRunSalesReports();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" /> Sales Reports
          </h1>
          <p className="text-sm text-muted-foreground">
            Live replacement for the monthly per-salesperson workbooks{monthLabel ? ` — ${monthLabel} close` : ""}.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="min-w-56">
            <label className="text-xs text-muted-foreground">Run</label>
            <Select value={runId ?? "latest"} onValueChange={(v) => setRunId(v === "latest" ? null : v)}>
              <SelectTrigger><SelectValue placeholder="Latest run" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Latest completed run</SelectItem>
                {runList.map((r: any) => (
                  <SelectItem key={r.id} value={r.id}>
                    {new Date(r.run_at).toLocaleString()} · {r.status} · {r.rep_count ?? 0} reps
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isAdmin && (
            <Button
              onClick={() =>
                runNow.mutate(undefined, {
                  onSuccess: (r: any) =>
                    toast.success(`Run ${r.status}: ${r.rows} rows across ${r.reps} reps`),
                  onError: (e: any) => toast.error(e?.message ?? "Run failed"),
                })
              }
              disabled={runNow.isPending}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${runNow.isPending ? "animate-spin" : ""}`} />
              {runNow.isPending ? "Running…" : "Run sales reports now"}
            </Button>
          )}
        </div>
      </div>

      {activeRun?.error && (
        <Card className="p-3 text-sm border-destructive/40 text-destructive flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {activeRun.error}
        </Card>
      )}

      {!activeRun && !overview.isLoading && (
        <Card className="p-6 text-sm text-muted-foreground">
          No completed runs yet.{isAdmin ? " Use “Run sales reports now” to build the first one." : " Ask an admin to run the reports."}
        </Card>
      )}

      {canManage && !detailRep && (
        <ManagerOverview
          reps={overview.data?.reps ?? []}
          monthLabel={monthLabel}
          loading={overview.isLoading}
          onSelect={setSelectedRep}
        />
      )}

      {detailRep && (
        <RepDetail
          rows={(detail.data?.rows ?? []) as SalesReportRow[]}
          monthLabel={monthLabel}
          year={activeRun?.period_year ?? new Date().getFullYear()}
          loading={detail.isLoading}
          repCode={detailRep}
          runId={activeRun?.id ?? null}
          onBack={canManage ? () => setSelectedRep(null) : undefined}
        />
      )}

      {!canManage && !access?.repCode && !overview.isLoading && (
        <Card className="p-6 text-sm text-muted-foreground">
          No sales rep code is linked to your profile. Ask an admin to set your rep code.
        </Card>
      )}
    </div>
  );
}

type OverviewSort = keyof RepSummary;

function ManagerOverview({
  reps, monthLabel, loading, onSelect,
}: { reps: RepSummary[]; monthLabel: string; loading: boolean; onSelect: (rep: string) => void }) {
  const [sort, setSort] = useState<OverviewSort>("ytd");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const click = (k: OverviewSort) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(k); setDir(k === "rep_name" ? "asc" : "desc"); }
  };
  const sorted = useMemo(() => {
    const arr = [...reps];
    arr.sort((a, b) => {
      const av = a[sort], bv = b[sort];
      const an = typeof av === "number" ? av : Number.NEGATIVE_INFINITY;
      const bn = typeof bv === "number" ? bv : Number.NEGATIVE_INFINITY;
      const cmp = typeof av === "string" && typeof bv === "string" ? av.localeCompare(bv) : an - bn;
      return dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [reps, sort, dir]);

  const totals = useMemo(
    () =>
      reps.reduce(
        (a, r) => ({
          ytd: a.ytd + r.ytd,
          ann: a.ann + r.annualized,
          month: a.month + r.month_sales,
          profit: a.profit + r.month_profit,
          risk: a.risk + r.at_risk,
          decl: a.decl + r.declining,
          win: a.win + r.win_backs,
        }),
        { ytd: 0, ann: 0, month: 0, profit: 0, risk: 0, decl: 0, win: 0 },
      ),
    [reps],
  );

  const priceLevelMapped = reps.length === 0 || reps.some((r) => r.price_level_mapped);

  return (
    <div className="space-y-4">
      {!priceLevelMapped && reps.length > 0 && (
        <Card className="p-3 text-sm flex items-start gap-2 border-amber-500/40 bg-amber-500/5">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
          <span>
            <strong>Awaiting price-level mapping.</strong> P21 at NDI has no identified price-level or
            buying-group source yet, so Price, BG and keep-level risk are blank rather than zero. Every other
            column is live.
          </span>
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="YTD sales (all reps)" value={money(totals.ytd)} icon={<BarChart3 className="w-5 h-5" />} />
        <KpiCard label={`${monthLabel} sales`} value={money(totals.month)} icon={<BarChart3 className="w-5 h-5" />} />
        <KpiCard
          label="Keep-level at risk"
          value={priceLevelMapped ? String(totals.risk) : "—"}
          sub={priceLevelMapped ? undefined : "Awaiting price-level mapping"}
          icon={<AlertTriangle className="w-5 h-5" />}
        />
        <KpiCard label="Win-back candidates" value={String(totals.win)} icon={<Undo2 className="w-5 h-5" />} />
      </div>

      <Card className="p-0 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead label="Salesperson" active={sort === "rep_name"} dir={dir} onClick={() => click("rep_name")} />
              <SortHead label="Customers" active={sort === "customers"} dir={dir} onClick={() => click("customers")} className="text-right" />
              <SortHead label="YTD" active={sort === "ytd"} dir={dir} onClick={() => click("ytd")} className="text-right" />
              <SortHead label="Annualized" active={sort === "annualized"} dir={dir} onClick={() => click("annualized")} className="text-right" />
              <SortHead label="vs prior yr" active={sort === "pct_vs_prior"} dir={dir} onClick={() => click("pct_vs_prior")} className="text-right" />
              <SortHead label={`${monthLabel} sales`} active={sort === "month_sales"} dir={dir} onClick={() => click("month_sales")} className="text-right" />
              <SortHead label={`${monthLabel} profit`} active={sort === "month_profit"} dir={dir} onClick={() => click("month_profit")} className="text-right" />
              <SortHead label="At risk" active={sort === "at_risk"} dir={dir} onClick={() => click("at_risk")} className="text-right" />
              <SortHead label="Declining" active={sort === "declining"} dir={dir} onClick={() => click("declining")} className="text-right" />
              <SortHead label="Win-backs" active={sort === "win_backs"} dir={dir} onClick={() => click("win_backs")} className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-8">Loading…</TableCell></TableRow>
            )}
            {!loading && sorted.length === 0 && (
              <TableRow><TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-8">No rows in this run.</TableCell></TableRow>
            )}
            {sorted.map((r) => (
              <TableRow key={r.rep_code} className="cursor-pointer" onClick={() => onSelect(r.rep_code)}>
                <TableCell className="font-medium">{r.rep_name} <span className="text-muted-foreground text-xs">({r.rep_code})</span></TableCell>
                <TableCell className="text-right">{r.customers}</TableCell>
                <TableCell className="text-right">{money(r.ytd)}</TableCell>
                <TableCell className="text-right">{money(r.annualized)}</TableCell>
                <TableCell className={`text-right ${(r.pct_vs_prior ?? 0) < 0 ? "text-destructive" : ""}`}>{pctFmt(r.pct_vs_prior)}</TableCell>
                <TableCell className="text-right">{money(r.month_sales)}</TableCell>
                <TableCell className="text-right">{money(r.month_profit)}</TableCell>
                <TableCell className="text-right">{r.at_risk ? <Badge variant="outline" className="border-amber-500 text-amber-600">{r.at_risk}</Badge> : "—"}</TableCell>
                <TableCell className="text-right">{r.declining ? <Badge variant="destructive">{r.declining}</Badge> : "—"}</TableCell>
                <TableCell className="text-right">{r.win_backs ? <Badge variant="secondary">{r.win_backs}</Badge> : "—"}</TableCell>
              </TableRow>
            ))}
            {!loading && sorted.length > 0 && (
              <TableRow className="font-semibold bg-muted/40">
                <TableCell>Total ({sorted.length} reps)</TableCell>
                <TableCell className="text-right">{reps.reduce((a, r) => a + r.customers, 0)}</TableCell>
                <TableCell className="text-right">{money(totals.ytd)}</TableCell>
                <TableCell className="text-right">{money(totals.ann)}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">{money(totals.month)}</TableCell>
                <TableCell className="text-right">{money(totals.profit)}</TableCell>
                <TableCell className="text-right">{totals.risk}</TableCell>
                <TableCell className="text-right">{totals.decl}</TableCell>
                <TableCell className="text-right">{totals.win}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

type DetailSort =
  | "cust_code" | "customer_name" | "total_value" | "y2022" | "y2023" | "y2024" | "y2025"
  | "y_current" | "ann_current" | "pct" | "month_sales" | "month_profit";

function RepDetail({
  rows, monthLabel, year, loading, repCode, runId, onBack,
}: {
  rows: SalesReportRow[]; monthLabel: string; year: number; loading: boolean;
  repCode: string; runId: string | null; onBack?: () => void;
}) {
  const [sort, setSort] = useState<DetailSort>("month_sales");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [price, setPrice] = useState("all");
  const [bg, setBg] = useState("all");
  const [search, setSearch] = useState("");
  const [insight, setInsight] = useState<"none" | "risk" | "declining" | "winback">("none");
  const exportWb = useExportRepWorkbook();

  const priceLevels = useMemo(() => [...new Set(rows.map((r) => r.price_level).filter(Boolean))] as string[], [rows]);
  const bgs = useMemo(() => [...new Set(rows.map((r) => r.bg).filter(Boolean))] as string[], [rows]);

  const counts = useMemo(
    () => ({
      risk: rows.filter(isAtRisk).length,
      declining: rows.filter(isDeclining).length,
      winback: rows.filter(isWinBack).length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (price !== "all" && r.price_level !== price) return false;
      if (bg !== "all" && r.bg !== bg) return false;
      if (q && !`${r.cust_code} ${r.customer_name ?? ""} ${r.city ?? ""}`.toLowerCase().includes(q)) return false;
      if (insight === "risk" && !isAtRisk(r)) return false;
      if (insight === "declining" && !isDeclining(r)) return false;
      if (insight === "winback" && !isWinBack(r)) return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      const av = a[sort] as any, bv = b[sort] as any;
      const cmp = typeof av === "string" || typeof bv === "string"
        ? String(av ?? "").localeCompare(String(bv ?? ""))
        : (av ?? Number.NEGATIVE_INFINITY) - (bv ?? Number.NEGATIVE_INFINITY);
      return dir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, price, bg, search, insight, sort, dir]);

  const click = (k: DetailSort) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(k); setDir(k === "cust_code" || k === "customer_name" ? "asc" : "desc"); }
  };

  const sum = (f: (r: SalesReportRow) => number | null) =>
    filtered.reduce((a, r) => a + (f(r) ?? 0), 0);

  const repName = rows[0]?.rep_name ?? repCode;
  const detailPriceLevelMapped = rows.length === 0 || hasPriceLevelMapping(rows);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="w-4 h-4 mr-1" /> All reps
            </Button>
          )}
          <h2 className="text-lg font-semibold">{repName} <span className="text-muted-foreground text-sm">({repCode})</span></h2>
        </div>
        <Button
          variant="outline"
          disabled={!runId || exportWb.isPending}
          onClick={() =>
            runId &&
            exportWb.mutate(
              { runId, repCode },
              { onError: (e: any) => toast.error(e?.message ?? "Export failed") },
            )
          }
        >
          <FileDown className="w-4 h-4 mr-2" /> {exportWb.isPending ? "Building…" : "Export XLSX"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {detailPriceLevelMapped ? (
          <Badge
            variant={insight === "risk" ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setInsight(insight === "risk" ? "none" : "risk")}
          >
            <AlertTriangle className="w-3 h-3 mr-1" /> Keep-level at risk · {counts.risk}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            <AlertTriangle className="w-3 h-3 mr-1" /> Keep-level: awaiting price-level mapping
          </Badge>
        )}
        <Badge
          variant={insight === "declining" ? "default" : "outline"}
          className="cursor-pointer"
          onClick={() => setInsight(insight === "declining" ? "none" : "declining")}
        >
          <TrendingDown className="w-3 h-3 mr-1" /> Declining &gt;20% · {counts.declining}
        </Badge>
        <Badge
          variant={insight === "winback" ? "default" : "outline"}
          className="cursor-pointer"
          onClick={() => setInsight(insight === "winback" ? "none" : "winback")}
        >
          <Undo2 className="w-3 h-3 mr-1" /> Win-backs · {counts.winback}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search customer, code or city" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-64" />
        <Select value={price} onValueChange={setPrice}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Price level" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All price levels</SelectItem>
            {priceLevels.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={bg} onValueChange={setBg}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Buying group" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All buying groups</SelectItem>
            {bgs.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card className="p-0 overflow-hidden">
        <Table className="table-fixed text-xs">
          <TableHeader>
            <TableRow>
              <SortHead label="Cust" active={sort === "cust_code"} dir={dir} onClick={() => click("cust_code")} className="w-20" />
              <TableHead className="w-16">Price</TableHead>
              <TableHead className="w-14">BG</TableHead>
              <SortHead label="Customer Name" active={sort === "customer_name"} dir={dir} onClick={() => click("customer_name")} />
              <TableHead className="w-28">City</TableHead>
              <TableHead className="w-10">St</TableHead>
              <SortHead label="Total" active={sort === "total_value"} dir={dir} onClick={() => click("total_value")} className="w-24 text-right" />
              <SortHead label="2022" active={sort === "y2022"} dir={dir} onClick={() => click("y2022")} className="w-20 text-right" />
              <SortHead label="2023" active={sort === "y2023"} dir={dir} onClick={() => click("y2023")} className="w-20 text-right" />
              <SortHead label="2024" active={sort === "y2024"} dir={dir} onClick={() => click("y2024")} className="w-20 text-right" />
              <SortHead label="2025" active={sort === "y2025"} dir={dir} onClick={() => click("y2025")} className="w-20 text-right" />
              <SortHead label={String(year)} active={sort === "y_current"} dir={dir} onClick={() => click("y_current")} className="w-20 text-right" />
              <SortHead label={`Ann ${year}`} active={sort === "ann_current"} dir={dir} onClick={() => click("ann_current")} className="w-20 text-right" />
              <SortHead label="Pct" active={sort === "pct"} dir={dir} onClick={() => click("pct")} className="w-16 text-right" />
              <SortHead label={`${monthLabel} Sales`} active={sort === "month_sales"} dir={dir} onClick={() => click("month_sales")} className="w-24 text-right" />
              <SortHead label={`${monthLabel} Profit`} active={sort === "month_profit"} dir={dir} onClick={() => click("month_profit")} className="w-24 text-right" />
              <TableHead className="w-24 text-right">Keep Lvl</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={17} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && filtered.length === 0 && (
              <TableRow><TableCell colSpan={17} className="text-center py-8 text-muted-foreground">No customers match.</TableCell></TableRow>
            )}
            {filtered.map((r) => {
              const exempt = isKeepLevelExempt(r.keep_lvl_code);
              const threshold = keepThresholdFor(r);
              const shortfall = r.keep_lvl_shortfall ?? (threshold !== null ? Math.max(0, threshold - (r.ann_current ?? 0)) : null);
              const atRisk = isAtRisk(r);
              return (
                <TableRow key={r.id ?? `${r.rep_code}-${r.cust_code}`}>
                  <TableCell className="truncate">{r.cust_code}</TableCell>
                  <TableCell className="truncate">{r.price_level ?? "—"}</TableCell>
                  <TableCell className="truncate">{r.bg ?? "—"}</TableCell>
                  <TableCell className="truncate" title={r.customer_name ?? ""}>{r.customer_name ?? "—"}</TableCell>
                  <TableCell className="truncate" title={r.city ?? ""}>{r.city ?? "—"}</TableCell>
                  <TableCell>{r.state ?? "—"}</TableCell>
                  <TableCell className="text-right">{money(r.total_value)}</TableCell>
                  <TableCell className="text-right">{money(r.y2022)}</TableCell>
                  <TableCell className="text-right">{money(r.y2023)}</TableCell>
                  <TableCell className="text-right">{money(r.y2024)}</TableCell>
                  <TableCell className="text-right">{money(r.y2025)}</TableCell>
                  <TableCell className="text-right">{money(r.y_current)}</TableCell>
                  <TableCell className="text-right">{money(r.ann_current)}</TableCell>
                  <TableCell className={`text-right ${(r.pct ?? 0) < 0 ? "text-destructive font-medium" : ""}`}>{pctFmt(r.pct)}</TableCell>
                  <TableCell className="text-right">{money(r.month_sales)}</TableCell>
                  <TableCell className="text-right">{money(r.month_profit)}</TableCell>
                  <TableCell className={`text-right ${atRisk ? "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200 font-medium" : ""}`}>
                    {exempt ? r.keep_lvl_code : shortfall !== null ? money(shortfall) : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
            {!loading && filtered.length > 0 && (
              <TableRow className="font-semibold bg-muted/40">
                <TableCell colSpan={6}>Total · {filtered.length} customers</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.total_value))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.y2022))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.y2023))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.y2024))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.y2025))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.y_current))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.ann_current))}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.month_sales))}</TableCell>
                <TableCell className="text-right">{money(sum((r) => r.month_profit))}</TableCell>
                <TableCell />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
