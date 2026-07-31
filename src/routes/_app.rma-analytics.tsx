import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { toast } from "sonner";
import {
  AlertTriangle, Download, FlaskConical, Loader2, PackageX, RefreshCw, TrendingDown, Truck, Users,
} from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { useAuth } from "@/lib/auth";
import { useModuleView } from "@/lib/usage-log";
import {
  useRmaOverview, useRmaAttribution, useRmaRows, useRmaDataSource,
  useSaveRmaDataSource, useTestRmaSql, useRunRmaSnapshot,
} from "@/hooks/useRmaAnalytics";
import { DIMENSIONS, DIMENSION_LABELS, type DimensionType } from "@/lib/rma/attribution";
import { REASON_BUCKETS, REASON_BUCKET_LABELS, type ReasonBucket } from "@/lib/rma/reasons";

export const Route = createFileRoute("/_app/rma-analytics")({
  head: () => ({
    meta: [
      { title: "RMA Analytics — Nelson AI for NDI" },
      { name: "description", content: "Attribute returns and damage on NDI's own trucks to the driver, route, puller, or dealer behind them." },
      { property: "og:title", content: "RMA Analytics — Nelson AI for NDI" },
      { property: "og:description", content: "Attribute returns and damage on NDI's own trucks to the driver, route, puller, or dealer behind them." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RmaAnalyticsPage,
});

const BUCKET_COLORS: Record<ReasonBucket, string> = {
  damaged: "hsl(var(--destructive))",
  wrong_pick: "hsl(var(--warning, 38 92% 50%))",
  customer_change: "hsl(var(--primary))",
  other: "hsl(var(--muted-foreground))",
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const RANGE_PRESETS = [
  { label: "Last 3 months", days: 90 },
  { label: "Last 6 months", days: 182 },
  { label: "Last 12 months", days: 365 },
  { label: "Last 24 months", days: 730 },
];

function RangeFilter({
  from, to, onChange,
}: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <Label className="text-xs text-muted-foreground">From</Label>
        <Input type="date" value={from} max={to} onChange={(e) => onChange(e.target.value, to)} className="h-9 w-[150px]" />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">To</Label>
        <Input type="date" value={to} min={from} max={today} onChange={(e) => onChange(from, e.target.value)} className="h-9 w-[150px]" />
      </div>
      <div className="flex gap-1">
        {RANGE_PRESETS.map((p) => (
          <Button key={p.days} variant="outline" size="sm" onClick={() => onChange(isoDaysAgo(p.days), today)}>
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <Card className="p-10 text-center">
      <PackageX className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </Card>
  );
}

function RmaAnalyticsPage() {
  const { hasRole } = useAuth();
  useModuleView("rma-analytics");
  const isAdmin = hasRole("admin") || hasRole("ops_logistics_admin");

  const [from, setFrom] = useState(() => isoDaysAgo(365));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const range = useMemo(() => ({ from, to }), [from, to]);

  return (
    <div>
      <ModuleHeader
        title="RMA Analytics"
        description="Where returns on our own trucks actually come from — driver, route, puller, or dealer."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/damage">Damage Tracker</Link>
          </Button>
        }
      />

      <Card className="p-4 mb-6">
        <RangeFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />
      </Card>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="attribution">Attribution</TabsTrigger>
          <TabsTrigger value="detail">Detail</TabsTrigger>
          {isAdmin && <TabsTrigger value="source">RMA Data Source</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-6"><OverviewTab range={range} /></TabsContent>
        <TabsContent value="attribution" className="mt-6"><AttributionTab range={range} /></TabsContent>
        <TabsContent value="detail" className="mt-6"><DetailTab range={range} /></TabsContent>
        {isAdmin && <TabsContent value="source" className="mt-6"><DataSourceTab /></TabsContent>}
      </Tabs>
    </div>
  );
}

/* ================================ OVERVIEW ================================ */

function OverviewTab({ range }: { range: { from: string; to: string } }) {
  const { data, isLoading, error } = useRmaOverview(range);

  if (isLoading) return <Card className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></Card>;
  if (error) return <EmptyState message={(error as Error).message} />;
  if (!data?.snapshot) {
    return <EmptyState message="No RMA snapshot yet. An admin needs to configure the RMA Data Source and run a snapshot." />;
  }

  const mix = data.reasonMix as Record<ReasonBucket, number>;
  const faultCount = mix.damaged + mix.wrong_pick;
  const faultShare = data.lineCount > 0 ? (faultCount / data.lineCount) * 100 : 0;

  const trend = (data.trend ?? []).map((t: any) => ({
    month: t.month.slice(0, 7),
    count: t.rmaCount,
    value: Math.round(t.rmaValue),
    ...t.reasons,
  }));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="RMAs" value={data.rmaCount.toLocaleString()} sub={`${data.lineCount.toLocaleString()} return lines`} icon={<PackageX className="w-5 h-5" />} />
        <KpiCard label="Credit value" value={money(data.totalValue)} sub={`${Math.round(data.totalQty).toLocaleString()} units returned`} icon={<TrendingDown className="w-5 h-5" />} />
        <KpiCard label="Our fault" value={`${faultShare.toFixed(0)}%`} sub={`${faultCount.toLocaleString()} damaged or wrong-pick lines`} icon={<AlertTriangle className="w-5 h-5" />} />
        <KpiCard label="Customer changed mind" value={mix.customer_change.toLocaleString()} sub={`${money((data.reasonValue as any).customer_change)} in credits`} icon={<Users className="w-5 h-5" />} />
      </div>

      <Card className="p-5">
        <h3 className="font-semibold mb-1">RMA trend by month</h3>
        <p className="text-xs text-muted-foreground mb-4">Return lines and credit value per month across the selected window.</p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis yAxisId="l" fontSize={12} />
              <YAxis yAxisId="r" orientation="right" fontSize={12} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
              <Tooltip />
              <Legend />
              <Line yAxisId="l" type="monotone" dataKey="count" name="Return lines" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              <Line yAxisId="r" type="monotone" dataKey="value" name="Credit $" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="font-semibold mb-1">Reason-code mix over time</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Damaged and wrong-pick are ours to fix; customer-changed-mind is a dealer-behaviour signal.
        </p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip />
              <Legend />
              {REASON_BUCKETS.map((b) => (
                <Bar key={b} dataKey={b} stackId="r" name={REASON_BUCKET_LABELS[b]} fill={BUCKET_COLORS[b]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="font-semibold mb-3">Reason mix totals</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Credit value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {REASON_BUCKETS.map((b) => (
              <TableRow key={b}>
                <TableCell className="font-medium">{REASON_BUCKET_LABELS[b]}</TableCell>
                <TableCell className="text-right">{mix[b].toLocaleString()}</TableCell>
                <TableCell className="text-right">
                  {data.lineCount > 0 ? `${((mix[b] / data.lineCount) * 100).toFixed(1)}%` : "—"}
                </TableCell>
                <TableCell className="text-right">{money((data.reasonValue as any)[b] ?? 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

/* =============================== ATTRIBUTION =============================== */

type SortKey = "value" | "count" | "rate" | "faultShare";

function AttributionTab({ range }: { range: { from: string; to: string } }) {
  const [minIncidents, setMinIncidents] = useState(5);
  const [multiple, setMultiple] = useState(2);
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const { data, isLoading, error } = useRmaAttribution(range, { minIncidents, multiple });

  if (isLoading) return <Card className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></Card>;
  if (error) return <EmptyState message={(error as Error).message} />;
  if (!data?.snapshot) return <EmptyState message="No RMA snapshot yet — nothing to attribute." />;

  return (
    <div className="space-y-6">
      <Card className="p-4 flex flex-wrap items-end gap-4">
        <div>
          <Label className="text-xs text-muted-foreground">Outlier threshold (× fleet average)</Label>
          <Input type="number" min={1} max={10} step={0.5} value={multiple}
            onChange={(e) => setMultiple(Math.max(1, Number(e.target.value) || 2))} className="h-9 w-[110px]" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Minimum incidents</Label>
          <Input type="number" min={1} max={100} value={minIncidents}
            onChange={(e) => setMinIncidents(Math.max(1, Number(e.target.value) || 5))} className="h-9 w-[110px]" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Sort by</Label>
          <Select value={sortKey} onValueChange={(v) => setSortKey(v as SortKey)}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="value">Credit value</SelectItem>
              <SelectItem value="count">RMA count</SelectItem>
              <SelectItem value="rate">Rate per shipment</SelectItem>
              <SelectItem value="faultShare">Damage/wrong-pick share</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground max-w-xl">
          An entity is flagged when its damage + wrong-pick rate is at least {multiple}× the fleet average
          with {minIncidents}+ incidents. Where no shipment count exists for a dimension, the flag falls back
          to that entity's damage/wrong-pick share of its own RMAs.
        </p>
      </Card>

      {DIMENSIONS.map((dim) => (
        <DimensionCard key={dim} dim={dim} data={(data.dimensions as any)[dim]} sortKey={sortKey} />
      ))}
    </div>
  );
}

function DimensionCard({ dim, data, sortKey }: { dim: DimensionType; data: any; sortKey: SortKey }) {
  const entities: any[] = data?.entities ?? [];
  const sorted = useMemo(() => {
    const arr = [...entities];
    arr.sort((a, b) => {
      if (sortKey === "count") return b.rmaCount - a.rmaCount;
      if (sortKey === "rate") return (b.ratePerShipment ?? -1) - (a.ratePerShipment ?? -1);
      if (sortKey === "faultShare") return b.faultShare - a.faultShare;
      return b.rmaValue - a.rmaValue;
    });
    return arr;
  }, [entities, sortKey]);

  const outliers = sorted.filter((e) => e.outlier);
  const icon = dim === "driver" || dim === "route" ? <Truck className="w-4 h-4" /> : <Users className="w-4 h-4" />;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="font-semibold flex items-center gap-2">{icon} By {DIMENSION_LABELS[dim].toLowerCase()}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {entities.length} {entities.length === 1 ? "entity" : "entities"}
            {data?.unattributed ? ` · ${data.unattributed} lines with no ${DIMENSION_LABELS[dim].toLowerCase()} on the record` : ""}
            {data?.fleetRate != null ? ` · fleet fault rate ${(data.fleetRate * 100).toFixed(1)}% per shipment` : ""}
            {data?.fleetRate == null ? ` · fleet damage/wrong-pick share ${((data?.fleetFaultShare ?? 0) * 100).toFixed(0)}%` : ""}
          </p>
        </div>
        {outliers.length > 0 && (
          <Badge variant="destructive" className="shrink-0">{outliers.length} outlier{outliers.length === 1 ? "" : "s"}</Badge>
        )}
      </div>

      {entities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {DIMENSION_LABELS[dim].toLowerCase()} values in the snapshot — the RMA query does not return this column yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{DIMENSION_LABELS[dim]}</TableHead>
                <TableHead className="text-right">RMAs</TableHead>
                <TableHead className="text-right">Credit value</TableHead>
                <TableHead className="text-right">Shipments</TableHead>
                <TableHead className="text-right">Fault rate</TableHead>
                <TableHead>Reason mix</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.slice(0, 50).map((e) => (
                <TableRow key={e.key} className={e.outlier ? "bg-destructive/5" : undefined}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span>{e.label}</span>
                      {e.outlier && (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="w-3 h-3" /> Outlier
                        </Badge>
                      )}
                    </div>
                    {e.outlier && <p className="text-[11px] text-muted-foreground mt-1">{e.outlierReason}</p>}
                  </TableCell>
                  <TableCell className="text-right">{e.rmaCount.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{money(e.rmaValue)}</TableCell>
                  <TableCell className="text-right">{e.volume ? e.volume.toLocaleString() : "—"}</TableCell>
                  <TableCell className="text-right">
                    {e.ratePerShipment != null
                      ? `${(e.ratePerShipment * 100).toFixed(1)}%`
                      : `${(e.faultShare * 100).toFixed(0)}% of RMAs`}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {REASON_BUCKETS.filter((b) => e.reasons[b] > 0).map((b) => (
                        <Badge key={b} variant={b === "damaged" ? "destructive" : "secondary"} className="text-[11px]">
                          {REASON_BUCKET_LABELS[b]} {e.reasons[b]}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {sorted.length > 50 && (
            <p className="text-xs text-muted-foreground mt-2">Showing top 50 of {sorted.length}.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ================================= DETAIL ================================= */

const DETAIL_COLUMNS = [
  ["rma_no", "RMA"],
  ["rma_date", "Date"],
  ["customer_name", "Dealer"],
  ["order_no", "Order"],
  ["item_id", "Item"],
  ["qty", "Qty"],
  ["value", "Value"],
  ["reason_code", "Reason code"],
  ["reason_bucket", "Bucket"],
  ["route_code", "Route"],
  ["driver_name", "Driver"],
  ["picker_name", "Picker"],
  ["warehouse_id", "Whse"],
] as const;

function DetailTab({ range }: { range: { from: string; to: string } }) {
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState("all");
  const { data, isLoading, error } = useRmaRows({ ...range, search, bucket });

  const exportCsv = () => {
    const rows: any[] = data?.rows ?? [];
    if (rows.length === 0) { toast.error("Nothing to export."); return; }
    const header = DETAIL_COLUMNS.map(([, label]) => label).join(",");
    const body = rows.map((r) =>
      DETAIL_COLUMNS.map(([key]) => {
        const v = (r as any)[key];
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","),
    ).join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rma-detail-${range.from}-to-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <EmptyState message={(error as Error).message} />;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="flex-1 min-w-[240px]">
          <Label className="text-xs text-muted-foreground">Search</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="RMA, order, dealer, item, driver, picker…" className="h-9" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Reason</Label>
          <Select value={bucket} onValueChange={setBucket}>
            <SelectTrigger className="h-9 w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {REASON_BUCKETS.map((b) => (
                <SelectItem key={b} value={b}>{REASON_BUCKET_LABELS[b]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} className="gap-2">
          <Download className="w-4 h-4" /> Export CSV
        </Button>
      </div>

      {isLoading ? (
        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : !data?.snapshot ? (
        <p className="text-sm text-muted-foreground">No RMA snapshot yet.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground mb-2">
            {data.total.toLocaleString()} matching lines{data.total > data.rows.length ? ` — showing first ${data.rows.length.toLocaleString()}` : ""}.
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {DETAIL_COLUMNS.map(([key, label]) => <TableHead key={key}>{label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.slice(0, 500).map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.rma_no ?? "—"}</TableCell>
                    <TableCell>{r.rma_date ?? "—"}</TableCell>
                    <TableCell>{r.customer_name ?? r.customer_id ?? "—"}</TableCell>
                    <TableCell>{r.order_no ?? "—"}</TableCell>
                    <TableCell>{r.item_id ?? "—"}</TableCell>
                    <TableCell>{Number(r.qty ?? 0).toLocaleString()}</TableCell>
                    <TableCell>{money(Number(r.value ?? 0))}</TableCell>
                    <TableCell>{r.reason_code ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={r.reason_bucket === "damaged" ? "destructive" : "secondary"} className="text-[11px]">
                        {REASON_BUCKET_LABELS[(r.reason_bucket as ReasonBucket) ?? "other"] ?? r.reason_bucket}
                      </Badge>
                    </TableCell>
                    <TableCell>{r.route_code ?? "—"}</TableCell>
                    <TableCell>{r.driver_name ?? "—"}</TableCell>
                    <TableCell>{r.picker_name ?? "—"}</TableCell>
                    <TableCell>{r.warehouse_id ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {data.rows.length > 500 && (
            <p className="text-xs text-muted-foreground mt-2">Rendering first 500 rows — export for the full set.</p>
          )}
        </>
      )}
    </Card>
  );
}

/* ============================== DATA SOURCE ============================== */

function DataSourceTab() {
  const { data, isLoading, error } = useRmaDataSource();
  const save = useSaveRmaDataSource();
  const test = useTestRmaSql();
  const run = useRunRmaSnapshot();
  const [sql, setSql] = useState<string | null>(null);

  const value = sql ?? data?.customSql ?? data?.defaultSql ?? "";

  if (isLoading) return <Card className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></Card>;
  if (error) return <EmptyState message={(error as Error).message} />;

  const onSave = async () => {
    try {
      const res = await save.mutateAsync(value.trim() || null);
      toast.success("RMA query saved.");
      for (const w of res.warnings ?? []) toast.warning(w);
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const onTest = async () => {
    try {
      const res = await test.mutateAsync(value);
      if (res.validation.errors.length > 0) {
        for (const e of res.validation.errors) toast.error(e);
      } else {
        toast.success(`Dry run returned ${res.rowCount} rows.`);
      }
      for (const w of res.validation.warnings) toast.warning(w);
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const onRun = async () => {
    try {
      const res = await run.mutateAsync();
      if (!res.ok) { toast.error(res.error ?? "Snapshot failed."); return; }
      toast.success(`Snapshot wrote ${res.rowsWritten} rows (${res.monthlyRows} monthly rollups).`);
      for (const w of res.warnings ?? []) toast.warning(w);
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const result = test.data;

  return (
    <div className="space-y-6">
      <Card className="p-4 border-warning/40 bg-warning/5">
        <div className="flex gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">Schema not yet verified against the live P21 install.</p>
            <p className="text-muted-foreground mt-1">
              The default query is written against common P21 RMA shapes (oe_hdr/oe_line with negative
              quantities, or rma_hdr/rma_line where present). <strong>Kevin must confirm the table and column
              names</strong> before these numbers are used in production — same process we followed for the
              truck-capacity demand query. Only the output aliases are contractual: rewrite the FROM/JOIN
              freely as long as <code>rma_no</code>, <code>rma_date</code>, <code>qty</code>,{" "}
              <code>value</code> and <code>reason_code</code> come back with those names.
            </p>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold">RMA extract SQL</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Read-only (SELECT / WITH only), executed through the P21 bridge agent.
              {data?.updatedAt ? ` Last saved ${new Date(data.updatedAt).toLocaleString()}.` : " Currently using the built-in default."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setSql(data?.defaultSql ?? "")}>Load default</Button>
            <Button variant="outline" size="sm" onClick={onTest} disabled={test.isPending} className="gap-2">
              {test.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
              Test snapshot
            </Button>
            <Button size="sm" onClick={onSave} disabled={save.isPending}>Save</Button>
            <Button size="sm" variant="secondary" onClick={onRun} disabled={run.isPending} className="gap-2">
              {run.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Run snapshot
            </Button>
          </div>
        </div>
        <Textarea value={value} onChange={(e) => setSql(e.target.value)} rows={20} spellCheck={false}
          className="font-mono text-xs" />
      </Card>

      {result && (
        <Card className="p-5">
          <h3 className="font-semibold mb-1">Dry-run result</h3>
          <p className="text-xs text-muted-foreground mb-3">
            {result.rowCount.toLocaleString()} rows · {result.columns.length} columns returned. Nothing was written.
          </p>
          <div className="flex flex-wrap gap-1 mb-4">
            {result.columns.map((c: string) => <Badge key={c} variant="outline" className="text-[11px] font-mono">{c}</Badge>)}
          </div>
          {result.sample.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>{result.columns.map((c: string) => <TableHead key={c} className="text-xs">{c}</TableHead>)}</TableRow>
                </TableHeader>
                <TableBody>
                  {result.sample.map((row: any, i: number) => (
                    <TableRow key={i}>
                      {result.columns.map((c: string) => (
                        <TableCell key={c} className="text-xs">{row[c] === null || row[c] === undefined ? "—" : String(row[c])}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      <Card className="p-5">
        <h3 className="font-semibold mb-3">Recent snapshots</h3>
        {(data?.snapshots ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No snapshots run yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Pulled</TableHead>
                <TableHead className="text-right">Written</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.snapshots ?? []).map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell>{new Date(s.started_at).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge variant={s.status === "ok" ? "secondary" : s.status === "error" ? "destructive" : "outline"}>
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{Number(s.rows_pulled ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-right">{Number(s.rows_written ?? 0).toLocaleString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[420px]">{s.error ?? s.notes ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
