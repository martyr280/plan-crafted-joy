import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, Plus, Trash2, Upload, Download, Play, RefreshCw, ChevronDown, Truck } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, ComposedChart, Legend,
} from "recharts";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { useAuth } from "@/lib/auth";
import {
  listTruckRoutes, listTruckRuns, upsertTruckRun, deleteTruckRun, getTruckForecast,
  getTruckSettings, updateTruckSettings, updateRoutePalletsPerTruck,
  previewTruckImport, commitTruckImport, exportTruckWorkbook, runP21SnapshotNow, testP21Sql,
  retrainTruckModel, listTruckModelVersions, getTruckAccuracy,
} from "@/lib/truck-capacity.functions";

export const Route = createFileRoute("/_app/truck-capacity")({ component: TruckCapacityPage });

const FLAG_AT_CAPACITY = 0.9;
const FLAG_CONSOLIDATION = 0.3;
const HUB_ORDER = ["Dallas", "Birmingham", "Ocala"];

type RouteRow = {
  id: string; code: string; name: string; hub: string; sort_order: number; active: boolean;
  has_vendor_pickup: boolean; truck_type: string | null; pallets_full_truck: number | null;
  p21_route_code: string | null; cutoff_time: string | null;
  cube_full_truck_ft3: number | null; weight_full_truck_lbs: number | null;
  p21_cities: string[] | null;
};
type RunRow = {
  id: string; route_id: string; run_date: string; run_seq: number; capacity_frac: number;
  vendor_pickup_frac: number | null; driver: string | null; pallet_count: number | null;
  returned_pallets: number | null; notes: string | null; source: string;
};

function pct(n: number | null | undefined) { return n == null ? "—" : `${(n * 100).toFixed(1)}%`; }
function flagFor(cap: number | null): { label: string; tone: "red" | "amber" | "green" | "muted" } | null {
  if (cap == null) return null;
  if (cap >= FLAG_AT_CAPACITY) return { label: "At capacity", tone: "red" };
  if (cap <= FLAG_CONSOLIDATION) return { label: "Consolidate", tone: "amber" };
  return null;
}

function TruckCapacityPage() {
  const { hasRole, hasAnyRole } = useAuth();
  const canWrite = hasAnyRole(["ops_orders", "admin"]);
  const isAdmin = hasRole("admin");

  const list = useServerFn(listTruckRoutes);
  const routesQ = useQuery({ queryKey: ["tc-routes"], queryFn: () => list() });
  const routes: RouteRow[] = routesQ.data?.routes ?? [];

  return (
    <div>
      <ModuleHeader
        title="Truck Capacity"
        description="Route-level truck utilization: capture daily runs, forecast the next four weeks, and export the workbook."
      />
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="route">Route</TabsTrigger>
          <TabsTrigger value="forecast">Forecast</TabsTrigger>
          {isAdmin && <TabsTrigger value="import">Import</TabsTrigger>}
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview"><OverviewTab routes={routes} /></TabsContent>
        <TabsContent value="route"><RouteTab routes={routes} canWrite={canWrite} /></TabsContent>
        <TabsContent value="forecast"><ForecastTab routes={routes} /></TabsContent>
        {isAdmin && <TabsContent value="import"><ImportTab /></TabsContent>}
        {isAdmin && <TabsContent value="settings"><SettingsTab routes={routes} /></TabsContent>}
      </Tabs>

    </div>
  );
}

/* ============================== OVERVIEW ============================== */

function OverviewTab({ routes }: { routes: RouteRow[] }) {
  const listRuns = useServerFn(listTruckRuns);
  const from = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() - 84); return d.toISOString().slice(0, 10);
  }, []);
  const runsQ = useQuery({
    queryKey: ["tc-runs-overview", from],
    queryFn: () => listRuns({ data: { from, limit: 5000 } }),
  });
  const runs: RunRow[] = runsQ.data?.rows ?? [];

  const byRoute = useMemo(() => {
    const m = new Map<string, RunRow[]>();
    for (const r of runs) {
      const arr = m.get(r.route_id) ?? [];
      arr.push(r); m.set(r.route_id, arr);
    }
    return m;
  }, [runs]);

  const exportFn = useServerFn(exportTruckWorkbook);
  async function download() {
    try {
      const { base64, filename } = await exportFn();
      const bin = atob(base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { toast.error(e?.message ?? "Export failed"); }
  }

  // Utilization heatmap: 12 weeks × routes, cell = mean(capacity_frac) for that week.
  // Weeks are Sunday-anchored; leftmost is 11 weeks ago, rightmost is the current week.
  const heat = useMemo(() => {
    const weekStarts: string[] = [];
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const currentSunday = new Date(todayUtc);
    currentSunday.setUTCDate(currentSunday.getUTCDate() - currentSunday.getUTCDay());
    for (let i = 11; i >= 0; i--) {
      const d = new Date(currentSunday);
      d.setUTCDate(d.getUTCDate() - i * 7);
      weekStarts.push(d.toISOString().slice(0, 10));
    }
    const weekOf = (iso: string): string => {
      const d = new Date(iso + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      return d.toISOString().slice(0, 10);
    };
    // routeId → weekStart → { sum, n }
    const acc = new Map<string, Map<string, { sum: number; n: number }>>();
    for (const r of runs) {
      const wk = weekOf(r.run_date);
      if (!weekStarts.includes(wk)) continue;
      const perRoute = acc.get(r.route_id) ?? new Map();
      const cell = perRoute.get(wk) ?? { sum: 0, n: 0 };
      cell.sum += Number(r.capacity_frac);
      cell.n += 1;
      perRoute.set(wk, cell);
      acc.set(r.route_id, perRoute);
    }
    return { weekStarts, acc };
  }, [runs]);

  function heatColor(mean: number | null): string {
    if (mean == null) return "bg-muted/30";
    if (mean >= FLAG_AT_CAPACITY) return "bg-red-500/80 text-white";
    if (mean <= FLAG_CONSOLIDATION) return "bg-amber-500/80 text-white";
    // Neutral gradient by intensity between 0.30 and 0.90.
    const t = Math.max(0, Math.min(1, (mean - FLAG_CONSOLIDATION) / (FLAG_AT_CAPACITY - FLAG_CONSOLIDATION)));
    if (t < 0.5) return "bg-emerald-500/40";
    return "bg-emerald-500/70 text-white";
  }

  const sortedRoutes = useMemo(() => {
    const order = new Map(HUB_ORDER.map((h, i) => [h, i]));
    return [...routes].filter((r) => r.active).sort((a, b) => {
      const ha = order.get(a.hub) ?? 99; const hb = order.get(b.hub) ?? 99;
      if (ha !== hb) return ha - hb;
      return a.sort_order - b.sort_order;
    });
  }, [routes]);

  const hubs = HUB_ORDER.filter((h) => routes.some((r) => r.hub === h));
  const flagLegend = (
    <div className="text-xs text-muted-foreground flex gap-4">
      <span><Badge variant="destructive" className="mr-1">≥ 90%</Badge>at capacity / second-truck risk</span>
      <span><Badge className="mr-1 bg-amber-500 hover:bg-amber-500">≤ 30%</Badge>consolidation candidate</span>
    </div>
  );

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between gap-3">
        {flagLegend}
        <Button variant="outline" size="sm" onClick={download}><Download className="w-4 h-4 mr-1" />Export workbook</Button>
      </div>
      {runsQ.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {sortedRoutes.length > 0 && (
        <Card className="p-4">
          <div className="font-semibold text-sm mb-1">Utilization heatmap — last 12 weeks</div>
          <div className="text-xs text-muted-foreground mb-3">Mean capacity per (route, week). Empty cell = no runs.</div>
          <div className="overflow-x-auto">
            <div
              className="grid gap-[2px] text-[10px]"
              style={{ gridTemplateColumns: `minmax(140px, 180px) repeat(${heat.weekStarts.length}, minmax(28px, 1fr))` }}
            >
              <div />
              {heat.weekStarts.map((w) => (
                <div key={w} className="text-center text-muted-foreground pb-1" title={`Week of ${w}`}>
                  {w.slice(5)}
                </div>
              ))}
              {sortedRoutes.map((r) => (
                <Fragment key={r.id}>
                  <div className="pr-2 truncate text-xs" title={`${r.hub} — ${r.name}`}>
                    <span className="text-muted-foreground">{r.hub[0]}·</span>{r.code}
                  </div>
                  {heat.weekStarts.map((w) => {
                    const cell = heat.acc.get(r.id)?.get(w);
                    const m = cell && cell.n > 0 ? cell.sum / cell.n : null;
                    return (
                      <div
                        key={`${r.id}-${w}`}
                        className={`h-6 rounded-sm flex items-center justify-center ${heatColor(m)}`}
                        title={m == null
                          ? `${r.code} · ${w}: no runs`
                          : `${r.code} · week of ${w}: ${(m * 100).toFixed(0)}% (n=${cell!.n})`}
                      >
                        {m == null ? "" : `${Math.round(m * 100)}`}
                      </div>
                    );
                  })}
                </Fragment>
              ))}

            </div>
          </div>
        </Card>
      )}

      {hubs.map((hub) => (
        <Card key={hub} className="p-4">
          <div className="font-semibold text-sm mb-3">{hub}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {routes.filter((r) => r.hub === hub && r.active).map((r) => {
              const rr = (byRoute.get(r.id) ?? []).slice().sort((a, b) => a.run_date.localeCompare(b.run_date));
              const last = rr.at(-1);
              const avg8 = rr.length ? rr.slice(-8).reduce((s, x) => s + Number(x.capacity_frac), 0) / Math.min(8, rr.length) : null;
              const flag = flagFor(last ? Number(last.capacity_frac) : null);
              return (
                <Card key={r.id} className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">{r.code}</div>
                    </div>
                    {flag && <Badge variant={flag.tone === "red" ? "destructive" : "secondary"} className={flag.tone === "amber" ? "bg-amber-500 hover:bg-amber-500 text-white" : ""}>{flag.label}</Badge>}
                  </div>
                  <div className="mt-2 flex justify-between text-xs">
                    <span>Last: <b>{pct(last ? Number(last.capacity_frac) : null)}</b> {last?.run_date}</span>
                    <span>8-wk avg: <b>{pct(avg8)}</b></span>
                  </div>
                  <div className="h-14 mt-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={rr.slice(-12).map((x) => ({ d: x.run_date, cap: Number(x.capacity_frac) }))}>
                        <YAxis hide domain={[0, 1.25]} />
                        <XAxis dataKey="d" hide />
                        <Line dataKey="cap" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                        <ReferenceLine y={0.9} stroke="hsl(var(--destructive))" strokeDasharray="3 3" />
                        <ReferenceLine y={0.3} stroke="orange" strokeDasharray="3 3" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Card>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}


/* ============================== ROUTE ============================== */

function RouteTab({ routes, canWrite }: { routes: RouteRow[]; canWrite: boolean }) {
  const [routeId, setRouteId] = useState<string>("");
  useEffect(() => { if (!routeId && routes[0]) setRouteId(routes[0].id); }, [routes, routeId]);
  const route = routes.find((r) => r.id === routeId);

  const listRuns = useServerFn(listTruckRuns);
  const qc = useQueryClient();
  const runsQ = useQuery({
    queryKey: ["tc-runs", routeId],
    queryFn: () => listRuns({ data: { routeId, limit: 500 } }),
    enabled: !!routeId,
  });
  const rows: RunRow[] = runsQ.data?.rows ?? [];

  const [editing, setEditing] = useState<Partial<RunRow> | null>(null);
  const upsert = useServerFn(upsertTruckRun);
  const del = useServerFn(deleteTruckRun);
  const mUpsert = useMutation({
    mutationFn: (r: any) => upsert({ data: r }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tc-runs"] }); qc.invalidateQueries({ queryKey: ["tc-runs-overview"] }); setEditing(null); toast.success("Saved"); },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });
  const mDel = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tc-runs"] }); toast.success("Deleted"); },
    onError: (e: any) => toast.error(e?.message ?? "Delete failed"),
  });

  const chartData = rows.slice().sort((a, b) => a.run_date.localeCompare(b.run_date))
    .map((r) => ({ d: r.run_date, capacity: Number(r.capacity_frac), unused: Math.max(0, 1 - Number(r.capacity_frac)) }));

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-3">
        <Label className="text-sm">Route</Label>
        <Select value={routeId} onValueChange={setRouteId}>
          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>
            {routes.map((r) => (<SelectItem key={r.id} value={r.id}>{r.hub} — {r.name} ({r.code})</SelectItem>))}
          </SelectContent>
        </Select>
        {canWrite && route && (
          <Button size="sm" onClick={() => setEditing({ route_id: route.id, run_date: new Date().toISOString().slice(0,10), run_seq: 1, capacity_frac: 0.5 })}>
            <Plus className="w-4 h-4 mr-1" />Add run
          </Button>
        )}
      </div>

      {route && chartData.length > 0 && (
        <Card className="p-3">
          <div className="text-xs font-medium mb-2">Capacity (last {chartData.length} runs)</div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <XAxis dataKey="d" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 1.25]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: any) => `${(Number(v) * 100).toFixed(1)}%`} />
                <Legend />
                <Area type="monotone" dataKey="capacity" stackId="a" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.4)" />
                <Area type="monotone" dataKey="unused" stackId="a" stroke="hsl(var(--muted-foreground))" fill="hsl(var(--muted) / 0.4)" />
                <ReferenceLine y={0.9} stroke="hsl(var(--destructive))" strokeDasharray="3 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="p-3">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Date</TableHead><TableHead>Run</TableHead><TableHead>Capacity</TableHead>
            <TableHead>Vendor Pickup</TableHead><TableHead>Driver</TableHead><TableHead>Pallets</TableHead>
            <TableHead>Returned</TableHead><TableHead>Notes</TableHead><TableHead>Source</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.run_date}</TableCell>
                <TableCell>{r.run_seq}</TableCell>
                <TableCell>{pct(Number(r.capacity_frac))}</TableCell>
                <TableCell>{pct(r.vendor_pickup_frac == null ? null : Number(r.vendor_pickup_frac))}</TableCell>
                <TableCell className="text-xs">{r.driver}</TableCell>
                <TableCell>{r.pallet_count}</TableCell>
                <TableCell>{r.returned_pallets}</TableCell>
                <TableCell className="text-xs max-w-[240px] truncate">{r.notes}</TableCell>
                <TableCell><Badge variant="outline" className="text-xs">{r.source}</Badge></TableCell>
                <TableCell className="text-right">
                  {canWrite && (
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => { if (confirm("Delete run?")) mDel.mutate(r.id); }}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground text-sm py-6">No runs yet</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.id ? "Edit run" : "Add run"}</DialogTitle></DialogHeader>
          {editing && (
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Date</Label><Input type="date" value={editing.run_date ?? ""} onChange={(e) => setEditing({ ...editing, run_date: e.target.value })} /></div>
              <div><Label>Run #</Label><Input type="number" min={1} value={editing.run_seq ?? 1} onChange={(e) => setEditing({ ...editing, run_seq: Number(e.target.value) })} /></div>
              <div><Label>Capacity (0–1.25)</Label><Input type="number" step="0.01" value={editing.capacity_frac ?? 0} onChange={(e) => setEditing({ ...editing, capacity_frac: Number(e.target.value) })} /></div>
              <div><Label>Vendor Pickup (optional)</Label><Input type="number" step="0.01" value={editing.vendor_pickup_frac ?? ""} onChange={(e) => setEditing({ ...editing, vendor_pickup_frac: e.target.value === "" ? null : Number(e.target.value) })} /></div>
              <div><Label>Driver</Label><Input value={editing.driver ?? ""} onChange={(e) => setEditing({ ...editing, driver: e.target.value })} /></div>
              <div><Label>Pallet count</Label><Input type="number" value={editing.pallet_count ?? ""} onChange={(e) => setEditing({ ...editing, pallet_count: e.target.value === "" ? null : Number(e.target.value) })} /></div>
              <div><Label>Returned pallets</Label><Input type="number" value={editing.returned_pallets ?? ""} onChange={(e) => setEditing({ ...editing, returned_pallets: e.target.value === "" ? null : Number(e.target.value) })} /></div>
              <div className="col-span-2"><Label>Notes</Label><Textarea rows={2} value={editing.notes ?? ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => editing && mUpsert.mutate(editing)} disabled={mUpsert.isPending}>{mUpsert.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ============================== FORECAST ============================== */

const FORECAST_METHOD = `Two layers, blended:
 1. Baseline (statistical): the last-12-weeks weekday pattern × trimmed-mean baseline per (route, weekday)
    over 56 days, times a shrunk monthly seasonal factor. Fallback chain is route → hub → 0.5.
    Explain string looks like "Thu baseline 0.72 (n=7) × Jul 0.94 = 0.68".
 2. Model (ridge regression): trained on the entire run history. Features cover weekday, month, hub,
    truck type, trend, and lag signals (EW-mean halflife=5, last run, same-weekday lag, overall mean,
    run count, missing-history flag, hub trailing 28d). Additive coefficients yield per-day drivers
    like "recent form +0.09, Friday +0.06, July +0.03".

Serving:
 • final = clamp(w · model + (1 − w) · baseline, 0, 1.25). (λ, w) selected by rolling-origin
   backtest (monthly cutoffs, 28d horizon). Grid: λ ∈ {0.3,1,3,10,30,100}, w ∈ {0, 0.3, 0.5, 0.7, 1.0}.
 • Promotion gate: the blend serves only if holdout MAE beats baseline. Otherwise baseline serves and
   the model is available as a toggle.
 • P21 max-guard: applied after blending; final = max(blend, P21). Excluded from MAE math.
 • Uncertainty band: ±1 MAD from per-route residuals of the promoted backtest (falls back to trailing MAD).

Thresholds: ≥ 0.90 = at-capacity (second-truck risk); ≤ 0.30 = consolidation candidate.`;

function ForecastTab({ routes }: { routes: RouteRow[] }) {
  const [routeId, setRouteId] = useState<string>("");
  const [method, setMethod] = useState<"auto" | "baseline" | "model">(() => {
    if (typeof window === "undefined") return "auto";
    return (localStorage.getItem("tc-method") as any) ?? "auto";
  });
  useEffect(() => { if (!routeId && routes[0]) setRouteId(routes[0].id); }, [routes, routeId]);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("tc-method", method); }, [method]);

  const fFn = useServerFn(getTruckForecast);
  const q = useQuery({
    queryKey: ["tc-forecast", routeId, method],
    queryFn: () => fFn({ data: { routeId, horizonDays: 28, method } }),
    enabled: !!routeId,
  });
  const accFn = useServerFn(getTruckAccuracy);
  const accQ = useQuery({ queryKey: ["tc-accuracy"], queryFn: () => accFn() });

  const days = (q.data?.days ?? []).map((d: any) => ({
    ...d,
    forecastPct: d.forecast == null ? null : d.forecast,
    modelPct: d.model == null ? null : d.model,
    blendPct: d.blend == null ? null : d.blend,
    p21Pct: d.p21 == null ? null : d.p21,
    finalPct: d.final,
    upper: d.forecast == null ? null : Math.min(1.25, d.forecast + d.mad),
    lower: d.forecast == null ? null : Math.max(0, d.forecast - d.mad),
  }));

  const version = q.data?.version;
  const servingMethod = q.data?.servingMethod ?? "baseline";

  return (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Label className="text-sm">Route</Label>
        <Select value={routeId} onValueChange={setRouteId}>
          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>
            {routes.map((r) => (<SelectItem key={r.id} value={r.id}>{r.hub} — {r.name}</SelectItem>))}
          </SelectContent>
        </Select>
        <Label className="text-sm ml-4">Method</Label>
        <Select value={method} onValueChange={(v: any) => setMethod(v)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (promoted)</SelectItem>
            <SelectItem value="baseline">Baseline only</SelectItem>
            <SelectItem value="model">Model (latest)</SelectItem>
          </SelectContent>
        </Select>
        {version ? (
          <Badge variant={version.promoted ? "default" : "outline"} className="text-xs">
            {version.promoted ? "Model promoted" : "Model available"} · λ={version.lambda} w={version.blend_w}
            {version.holdout_mae_blend != null && version.holdout_mae_baseline != null
              ? ` · MAE ${Number(version.holdout_mae_blend).toFixed(3)} vs ${Number(version.holdout_mae_baseline).toFixed(3)}`
              : ""}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">Baseline serving · no model yet</Badge>
        )}
        <Badge variant="secondary" className="text-xs">Serving: {servingMethod}</Badge>
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-xs"><ChevronDown className="w-3 h-3 mr-1" />How this forecast works</Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card className="p-3 text-xs whitespace-pre-line text-muted-foreground">{FORECAST_METHOD}</Card>
        </CollapsibleContent>
      </Collapsible>

      {q.isLoading && <div className="text-sm text-muted-foreground">Computing…</div>}
      {days.length > 0 && (
        <Card className="p-3">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={days}>
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 1.5]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
                <Tooltip content={<ForecastTooltip />} />
                <Legend />
                <Area type="monotone" dataKey="upper" stroke="none" fill="hsl(var(--primary) / 0.15)" name="±MAD upper" />
                <Area type="monotone" dataKey="lower" stroke="none" fill="hsl(var(--background))" name="±MAD lower" />
                <Line type="monotone" dataKey="forecastPct" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="Baseline" />
                {version && <Line type="monotone" dataKey="modelPct" stroke="hsl(var(--chart-2, 200 80% 50%))" strokeWidth={1} strokeDasharray="5 3" dot={false} name="Model" />}
                {version && <Line type="monotone" dataKey="blendPct" stroke="hsl(var(--foreground))" strokeWidth={2} dot={false} name="Blend" />}
                <Line type="monotone" dataKey="p21Pct" stroke="hsl(var(--destructive))" strokeWidth={1} dot={{ r: 3 }} name="P21 projection" />
                <Line type="monotone" dataKey="finalPct" stroke="hsl(var(--foreground))" strokeWidth={1} strokeDasharray="4 4" dot={false} name="Final (served)" />
                <ReferenceLine y={0.9} stroke="hsl(var(--destructive))" strokeDasharray="3 3" />
                <ReferenceLine y={0.3} stroke="orange" strokeDasharray="3 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {days.length > 0 && (
        <Card className="p-3">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>DoW</TableHead><TableHead>Baseline</TableHead>
              <TableHead>Model</TableHead><TableHead>Blend</TableHead><TableHead>P21</TableHead>
              <TableHead>Final</TableHead><TableHead>Method</TableHead><TableHead>Drivers</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {days.map((d) => (
                <TableRow key={d.date}>
                  <TableCell>{d.date}</TableCell>
                  <TableCell>{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.dow]}</TableCell>
                  <TableCell>{pct(d.baseline)}</TableCell>
                  <TableCell>{pct(d.model)}</TableCell>
                  <TableCell>{pct(d.blend)}</TableCell>
                  <TableCell>{pct(d.p21)}</TableCell>
                  <TableCell className="font-medium">{pct(d.final)}</TableCell>
                  <TableCell><Badge variant="outline" className="text-xs">{d.method}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[320px]">{d.driverSummary ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <AccuracyPanel accQuery={accQ} routes={routes} />
    </div>
  );
}

function ForecastTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded border bg-background p-2 text-xs shadow-md max-w-[320px]">
      <div className="font-medium">{d.date}</div>
      <div className="text-muted-foreground whitespace-pre-line">{d.explain}</div>
    </div>
  );
}

function AccuracyPanel({ accQuery, routes }: { accQuery: any; routes: RouteRow[] }) {
  const v = accQuery.data?.promoted ?? accQuery.data?.latest;
  if (!v) return <Card className="p-3 text-xs text-muted-foreground">No trained model yet. Import history and run a retrain to populate accuracy.</Card>;
  const per = (v.per_route_mae ?? {}) as Record<string, { baseline: number; model: number; blend: number; n: number }>;
  const routeName = new Map(routes.map((r) => [r.id, `${r.hub[0]}·${r.code}`]));
  const rows = Object.entries(per)
    .filter(([, m]) => (m.n ?? 0) > 0)
    .map(([rid, m]) => ({ rid, name: routeName.get(rid) ?? rid.slice(0, 8), ...m, delta: m.baseline - m.blend }))
    .sort((a, b) => b.delta - a.delta);
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">Model accuracy</div>
        <div className="text-xs text-muted-foreground">
          {v.promoted ? "Promoted" : "Latest (not promoted)"} · trained {new Date(v.trained_at).toLocaleString()}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <StatCell label="Baseline MAE" value={v.holdout_mae_baseline} />
        <StatCell label="Model MAE" value={v.holdout_mae_model} />
        <StatCell label="Blend MAE" value={v.holdout_mae_blend} />
        <StatCell label="Baseline WAPE" value={v.wape_baseline} pct />
        <StatCell label="Model WAPE" value={v.wape_model} pct />
        <StatCell label="Blend WAPE" value={v.wape_blend} pct />
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Lane</TableHead><TableHead>n</TableHead>
          <TableHead>Baseline</TableHead><TableHead>Model</TableHead><TableHead>Blend</TableHead><TableHead>Δ vs baseline</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rid}>
              <TableCell className="text-xs">{r.name}</TableCell>
              <TableCell className="text-xs">{r.n}</TableCell>
              <TableCell className="text-xs">{r.baseline?.toFixed(3)}</TableCell>
              <TableCell className="text-xs">{r.model?.toFixed(3)}</TableCell>
              <TableCell className="text-xs font-medium">{r.blend?.toFixed(3)}</TableCell>
              <TableCell className={`text-xs ${r.delta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                {r.delta >= 0 ? "+" : ""}{r.delta?.toFixed(3)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function StatCell({ label, value, pct: isPct }: { label: string; value: number | null | undefined; pct?: boolean }) {
  const num = value == null ? null : Number(value);
  const display = num == null ? "—" : isPct ? `${(num * 100).toFixed(1)}%` : num.toFixed(3);
  return (
    <div className="rounded border p-2">
      <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
      <div className="text-sm font-semibold">{display}</div>
    </div>
  );
}


/* ============================== IMPORT ============================== */

function ImportTab() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<any>(null);
  const preview = useServerFn(previewTruckImport);
  const commit = useServerFn(commitTruckImport);

  async function onFile(file: File) {
    setBusy(true); setReport(null);
    try {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
        r.onerror = reject; r.readAsDataURL(file);
      });
      const rep = await preview({ data: { fileBase64: b64 } });
      setReport(rep);
    } catch (e: any) { toast.error(e?.message ?? "Preview failed"); }
    finally { setBusy(false); }
  }

  async function onCommit() {
    if (!report?.rows) return;
    setBusy(true);
    try {
      const { inserted } = await commit({ data: { rows: report.rows } });
      toast.success(`Imported ${inserted} runs`);
      setReport(null);
    } catch (e: any) { toast.error(e?.message ?? "Import failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 pt-4">
      <Card className="p-4">
        <div className="text-sm font-medium mb-2">One-time seed from the "Primary Truck Capacity" workbook</div>
        <div className="text-xs text-muted-foreground mb-3">
          Upload the .xlsx — a dry-run will show per-sheet counts before any rows are written. Rows with year &lt; 2020, missing dates, or missing capacity are skipped. Dates with " - Run 2/3" suffix become <code>run_seq</code>.
        </div>
        <Input type="file" accept=".xlsx" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} disabled={busy} />
      </Card>

      {report && (
        <Card className="p-3">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm">Dry-run preview: <b>{report.totalOk}</b> rows ready to import.</div>
            <Button onClick={onCommit} disabled={busy || report.totalOk === 0}>
              {busy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Commit import
            </Button>
          </div>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Sheet</TableHead><TableHead>Route</TableHead><TableHead>Status</TableHead>
              <TableHead>OK</TableHead><TableHead>Bad date</TableHead><TableHead>No capacity</TableHead><TableHead>Old year</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {report.sheets.map((s: any) => (
                <TableRow key={s.sheet}>
                  <TableCell>{s.sheet}</TableCell>
                  <TableCell className="text-xs">{s.route_code ?? "—"}</TableCell>
                  <TableCell><Badge variant={s.status === "ok" ? "default" : "outline"}>{s.status}</Badge></TableCell>
                  <TableCell>{s.ok}</TableCell>
                  <TableCell>{s.skipped_bad_date}</TableCell>
                  <TableCell>{s.skipped_no_capacity}</TableCell>
                  <TableCell>{s.skipped_old_year}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/* ============================== SETTINGS ============================== */

function SettingsTab({ routes }: { routes: RouteRow[] }) {
  const settingsFn = useServerFn(getTruckSettings);
  const updateFn = useServerFn(updateTruckSettings);
  const palletsFn = useServerFn(updateRoutePalletsPerTruck);
  const testFn = useServerFn(testP21Sql);
  const snapFn = useServerFn(runP21SnapshotNow);
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ["tc-settings"], queryFn: () => settingsFn() });
  const s = q.data?.settings;
  const defaultSql: string = q.data?.defaultP21Sql ?? "";

  const [basis, setBasis] = useState<"pallets"|"weight"|"cube">("pallets");
  const [vendorCounts, setVendorCounts] = useState(false);
  const [sql, setSql] = useState("");
  useEffect(() => {
    if (s) { setBasis(s.capacity_basis as "pallets"|"weight"|"cube"); setVendorCounts(s.vendor_pickup_counts); setSql(s.p21_sql ?? defaultSql); }
  }, [s, defaultSql]);

  type RouteEdit = {
    pallets_full_truck: string;
    cube_full_truck_ft3: string;
    weight_full_truck_lbs: string;
    p21_route_code: string;
    cutoff_time: string;
    p21_cities: string;
  };
  const [routeEdits, setRouteEdits] = useState<Record<string, RouteEdit>>({});
  useEffect(() => {
    const m: Record<string, RouteEdit> = {};
    for (const r of routes) m[r.id] = {
      pallets_full_truck: r.pallets_full_truck?.toString() ?? "",
      cube_full_truck_ft3: r.cube_full_truck_ft3?.toString() ?? "",
      weight_full_truck_lbs: r.weight_full_truck_lbs?.toString() ?? "",
      p21_route_code: r.p21_route_code ?? "",
      cutoff_time: r.cutoff_time ?? "",
      p21_cities: (r.p21_cities ?? []).join(", "),
    };
    setRouteEdits(m);
  }, [routes]);
  function patchRoute(id: string, patch: Partial<RouteEdit>) {
    setRouteEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  const [testResult, setTestResult] = useState<any>(null);
  const [snapResult, setSnapResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save() {
    setBusy("save");
    try {
      await updateFn({ data: { capacity_basis: basis, vendor_pickup_counts: vendorCounts, p21_sql: sql } });
      const numOrNull = (v: string) => v === "" ? null : Number(v);
      const strOrNull = (v: string) => v.trim() === "" ? null : v.trim();
      const citiesOrNull = (v: string) => {
        const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
        return parts.length === 0 ? null : parts;
      };
      const updates = routes.map((r) => {
        const e = routeEdits[r.id];
        return {
          id: r.id,
          pallets_full_truck: e ? numOrNull(e.pallets_full_truck) : null,
          cube_full_truck_ft3: e ? numOrNull(e.cube_full_truck_ft3) : null,
          weight_full_truck_lbs: e ? numOrNull(e.weight_full_truck_lbs) : null,
          p21_route_code: e ? strOrNull(e.p21_route_code) : null,
          cutoff_time: e ? strOrNull(e.cutoff_time) : null,
          p21_cities: e ? citiesOrNull(e.p21_cities) : null,
        };
      });
      await palletsFn({ data: { updates } });
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["tc-settings"] });
      qc.invalidateQueries({ queryKey: ["tc-routes"] });
    } catch (e: any) { toast.error(e?.message ?? "Save failed"); }
    finally { setBusy(null); }
  }

  async function test() {
    setBusy("test"); setTestResult(null);
    try { setTestResult(await testFn({ data: { sql } })); }
    catch (e: any) { toast.error(e?.message ?? "Test failed"); }
    finally { setBusy(null); }
  }

  async function snap() {
    setBusy("snap"); setSnapResult(null);
    try { setSnapResult(await snapFn()); toast.success("Snapshot run"); }
    catch (e: any) { toast.error(e?.message ?? "Snapshot failed"); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-4 pt-4">
      <Card className="p-4 space-y-3">
        <div className="text-sm font-medium">Capacity model</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">Capacity basis</Label>
            <Select value={basis} onValueChange={(v: any) => setBasis(v)}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pallets">Pallets</SelectItem>
                <SelectItem value="weight">Weight</SelectItem>
                <SelectItem value="cube">Cube</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground mt-1">Which physical dimension defines "full truck". Client to confirm.</div>
          </div>
          <div>
            <Label className="text-xs">Vendor pickups count against forecast</Label>
            <div className="flex items-center gap-2 h-9">
              <Switch checked={vendorCounts} onCheckedChange={setVendorCounts} />
              <span className="text-xs text-muted-foreground">When on, vendor pickup capacity is added to the run baseline.</span>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="text-sm font-medium mb-2">Route metadata &amp; truck-full targets</div>
        <div className="text-xs text-muted-foreground mb-3">
          P21 route code (Order Entry → Ship Info → Route) drives the projection match. Multiple codes allowed — enter comma-separated (e.g. <code>ARK01,ARK02</code>). Leave blank for lanes the client hasn&apos;t confirmed.
          When a P21 code is claimed by more than one route, the server resolves per row by (1) <b>ship_city</b> against each claimant&apos;s Cities list, then (2) shipment weekday against <code>typical_dow</code>, then (3) lowest sort_order (with an audit warning). Populate Cities for shared codes like <code>NSC01</code> (Carolinas).
          Truck-full targets compute projected_capacity_frac = min(1.5, max of pallets/cube/weight ratios).
          Per Joe: pallet counts are approximate (pallet sizes vary 48&quot;–104&quot;, small orders load loose, maxed trailers are topped off with loose product), so cube or weight is often the binding constraint.
          Cutoff time is display-only for now (from the Driver Routes sheet).
          <br /><span className="text-amber-600">Pending client confirmation:</span> <code>SOCA1</code> (Carolinas code on the Ocala tab).
          <br /><span className="text-muted-foreground">Transfer lanes (<code>BHM-XFER-DAL</code>, <code>DAL-XFER-BHM</code>, <code>BHM-XFER-OCA</code>) don&apos;t receive P21 demand yet — the <code>transfer_hdr</code>/<code>transfer_line</code> query is phase 2.</span>
          <br /><span className="text-muted-foreground">Note:</span> <code>DAL-XFER-BHM</code> (Dallas Transfer) also carries Ocala → Dallas freight per Joe, so its utilization reads higher than Birmingham-only demand would suggest.

        </div>
        <div className="overflow-auto max-h-[420px] border rounded">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 sticky top-0">
              <tr>
                <th className="text-left p-2">Route</th>
                <th className="text-left p-2">P21 code</th>
                <th className="text-left p-2">Cities (shared-code resolver)</th>
                <th className="text-left p-2">Cutoff</th>
                <th className="text-right p-2">Pallets/full</th>
                <th className="text-right p-2">Cube ft³/full</th>
                <th className="text-right p-2">Weight lbs/full</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => {
                const e = routeEdits[r.id];
                if (!e) return null;
                return (
                  <tr key={r.id} className="border-t">
                    <td className="p-2 whitespace-nowrap"><span className="font-medium">{r.code}</span> <span className="text-muted-foreground">· {r.hub}</span></td>
                    <td className="p-1"><Input className="h-7" value={e.p21_route_code} placeholder="e.g. ARK01,ARK02" onChange={(ev) => patchRoute(r.id, { p21_route_code: ev.target.value })} /></td>
                    <td className="p-1"><Input className="h-7" value={e.p21_cities} placeholder="Charlotte, Columbia, …" onChange={(ev) => patchRoute(r.id, { p21_cities: ev.target.value })} /></td>
                    <td className="p-1"><Input className="h-7 w-24" value={e.cutoff_time} placeholder="—" onChange={(ev) => patchRoute(r.id, { cutoff_time: ev.target.value })} /></td>
                    <td className="p-1"><Input type="number" className="h-7 w-20 ml-auto text-right" value={e.pallets_full_truck} onChange={(ev) => patchRoute(r.id, { pallets_full_truck: ev.target.value })} /></td>
                    <td className="p-1"><Input type="number" className="h-7 w-24 ml-auto text-right" value={e.cube_full_truck_ft3} onChange={(ev) => patchRoute(r.id, { cube_full_truck_ft3: ev.target.value })} /></td>
                    <td className="p-1"><Input type="number" className="h-7 w-24 ml-auto text-right" value={e.weight_full_truck_lbs} onChange={(ev) => patchRoute(r.id, { weight_full_truck_lbs: ev.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">P21 projection SQL</div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={test} disabled={busy === "test"}>{busy === "test" ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Play className="w-4 h-4 mr-1" />}Test</Button>
            <Button size="sm" variant="outline" onClick={snap} disabled={busy === "snap"}>{busy === "snap" ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}Run snapshot now</Button>
          </div>
        </div>
        <div className="text-xs text-muted-foreground mb-2">Must return: <code>route_code, ship_date, order_count, total_weight_lbs, total_cube_ft, est_pallets</code>.</div>
        <Textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={14} className="font-mono text-xs" />
        {testResult && <div className="text-xs mt-2">Test: <b>{testResult.rowCount}</b> rows. Sample: <pre className="bg-muted p-2 rounded max-h-40 overflow-auto">{JSON.stringify(testResult.sample, null, 2)}</pre></div>}
        {snapResult && <div className="text-xs mt-2">Snapshot: pulled {snapResult.rowsPulled}, wrote {snapResult.snapshotsWritten}. Unmatched codes: {snapResult.unmatchedRouteCodes?.join(", ") || "—"}</div>}
      </Card>

      <RetrainCard />

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy === "save"}>{busy === "save" && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Save settings</Button>
      </div>
    </div>
  );
}

function RetrainCard() {
  const retrainFn = useServerFn(retrainTruckModel);
  const versionsFn = useServerFn(listTruckModelVersions);
  const qc = useQueryClient();
  const vQ = useQuery({ queryKey: ["tc-model-versions"], queryFn: () => versionsFn() });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<any>(null);
  async function run() {
    setBusy(true); setLast(null);
    try {
      const r = await retrainFn();
      setLast(r);
      if (r?.ok) toast.success(`Retrained: blend MAE ${Number(r.holdout_mae_blend).toFixed(3)} vs baseline ${Number(r.holdout_mae_baseline).toFixed(3)} — ${r.promoted ? "promoted" : "kept baseline"}`);
      else toast.error(r?.error ?? "Retrain failed");
      qc.invalidateQueries({ queryKey: ["tc-model-versions"] });
      qc.invalidateQueries({ queryKey: ["tc-accuracy"] });
      qc.invalidateQueries({ queryKey: ["tc-forecast"] });
    } catch (e: any) { toast.error(e?.message ?? "Retrain failed"); }
    finally { setBusy(false); }
  }
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">Forecast model</div>
        <Button size="sm" variant="outline" onClick={run} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}Retrain now
        </Button>
      </div>
      <div className="text-xs text-muted-foreground mb-3">Nightly retrain runs automatically at ~03:00 EDT. Manual retrain trains + backtests + promotes if the blend beats baseline.</div>
      {last && (
        <div className="text-xs mb-3">
          Last: λ={last.chosenLambda}, w={last.chosenW}, blend MAE {Number(last.holdout_mae_blend ?? 0).toFixed(4)} vs baseline {Number(last.holdout_mae_baseline ?? 0).toFixed(4)} · {last.promoted ? "PROMOTED" : "not promoted"} · folds {last.fold_count}
        </div>
      )}
      <Table>
        <TableHeader><TableRow>
          <TableHead>Trained</TableHead><TableHead>λ</TableHead><TableHead>w</TableHead>
          <TableHead>Rows</TableHead><TableHead>Baseline MAE</TableHead><TableHead>Blend MAE</TableHead><TableHead>Promoted</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {(vQ.data?.versions ?? []).map((v: any) => (
            <TableRow key={v.id}>
              <TableCell className="text-xs">{new Date(v.trained_at).toLocaleString()}</TableCell>
              <TableCell className="text-xs">{v.lambda}</TableCell>
              <TableCell className="text-xs">{v.blend_w}</TableCell>
              <TableCell className="text-xs">{v.train_rows}</TableCell>
              <TableCell className="text-xs">{v.holdout_mae_baseline == null ? "—" : Number(v.holdout_mae_baseline).toFixed(4)}</TableCell>
              <TableCell className="text-xs">{v.holdout_mae_blend == null ? "—" : Number(v.holdout_mae_blend).toFixed(4)}</TableCell>
              <TableCell><Badge variant={v.promoted ? "default" : "outline"} className="text-xs">{v.promoted ? "yes" : "no"}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

