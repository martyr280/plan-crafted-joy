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
} from "@/lib/truck-capacity.functions";

export const Route = createFileRoute("/_app/truck-capacity")({ component: TruckCapacityPage });

const FLAG_AT_CAPACITY = 0.9;
const FLAG_CONSOLIDATION = 0.3;
const HUB_ORDER = ["Dallas", "Birmingham", "Ocala"];

type RouteRow = {
  id: string; code: string; name: string; hub: string; sort_order: number; active: boolean;
  has_vendor_pickup: boolean; truck_type: string | null; pallets_full_truck: number | null;
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

const FORECAST_METHOD = `For each route we scan the last 12 weeks of runs and identify which weekdays the route typically operates.
For each future day within the horizon that falls on one of those weekdays:
 • baseline = trimmed mean (drop top/bottom 10%) of capacity for that (route, weekday) over the last 8 weeks.
   Fallback to route mean → hub mean → 0.5 when n < 3.
 • month factor = shrunk (n·raw + 4) / (n + 4), where raw = mean(current month) / mean(all months).
 • forecast = clamp(baseline × month_factor, 0, 1.25).
 • ±1 MAD band shown around the trailing window.
 • P21 overlay: if a snapshot exists for that date, its projected_capacity_frac is plotted.
 • final = max(statistical forecast, P21 projection). Both series are visible; hover for the explain string.
Thresholds: runs/forecasts ≥ 0.90 are flagged as at-capacity (second-truck risk); ≤ 0.30 as a consolidation candidate.`;

function ForecastTab({ routes }: { routes: RouteRow[] }) {
  const [routeId, setRouteId] = useState<string>("");
  useEffect(() => { if (!routeId && routes[0]) setRouteId(routes[0].id); }, [routes, routeId]);

  const fFn = useServerFn(getTruckForecast);
  const q = useQuery({
    queryKey: ["tc-forecast", routeId],
    queryFn: () => fFn({ data: { routeId, horizonDays: 28 } }),
    enabled: !!routeId,
  });
  const days = (q.data?.days ?? []).map((d: any) => ({
    ...d,
    forecastPct: d.forecast == null ? null : d.forecast,
    p21Pct: d.p21 == null ? null : d.p21,
    finalPct: d.final,
    upper: d.forecast == null ? null : Math.min(1.25, d.forecast + d.mad),
    lower: d.forecast == null ? null : Math.max(0, d.forecast - d.mad),
  }));

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-3">
        <Label className="text-sm">Route</Label>
        <Select value={routeId} onValueChange={setRouteId}>
          <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>
            {routes.map((r) => (<SelectItem key={r.id} value={r.id}>{r.hub} — {r.name}</SelectItem>))}
          </SelectContent>
        </Select>
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
                <Line type="monotone" dataKey="forecastPct" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name="Statistical" />
                <Line type="monotone" dataKey="p21Pct" stroke="hsl(var(--destructive))" strokeWidth={1} dot={{ r: 3 }} name="P21 projection" />
                <Line type="monotone" dataKey="finalPct" stroke="hsl(var(--foreground))" strokeWidth={1} strokeDasharray="4 4" dot={false} name="Final (max)" />
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
              <TableHead>Month factor</TableHead><TableHead>Forecast</TableHead>
              <TableHead>P21</TableHead><TableHead>Final</TableHead><TableHead>Explain</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {days.map((d) => (
                <TableRow key={d.date}>
                  <TableCell>{d.date}</TableCell>
                  <TableCell>{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.dow]}</TableCell>
                  <TableCell>{pct(d.baseline)}</TableCell>
                  <TableCell>{d.seasonal?.toFixed(2)}</TableCell>
                  <TableCell>{pct(d.forecast)}</TableCell>
                  <TableCell>{pct(d.p21)}</TableCell>
                  <TableCell className="font-medium">{pct(d.final)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.explain}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ForecastTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded border bg-background p-2 text-xs shadow-md max-w-[300px]">
      <div className="font-medium">{d.date}</div>
      <div className="text-muted-foreground">{d.explain}</div>
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

  const [pallets, setPallets] = useState<Record<string, string>>({});
  useEffect(() => {
    const m: Record<string, string> = {};
    for (const r of routes) m[r.id] = r.pallets_full_truck?.toString() ?? "";
    setPallets(m);
  }, [routes]);

  const [testResult, setTestResult] = useState<any>(null);
  const [snapResult, setSnapResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save() {
    setBusy("save");
    try {
      await updateFn({ data: { capacity_basis: basis, vendor_pickup_counts: vendorCounts, p21_sql: sql } });
      const updates = routes.map((r) => ({ id: r.id, pallets_full_truck: pallets[r.id] === "" ? null : Number(pallets[r.id]) }));
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
        <div className="text-sm font-medium mb-2">Pallets per full truck (per route)</div>
        <div className="text-xs text-muted-foreground mb-3">Used to project P21 est_pallets → projected_capacity_frac = min(1.5, est_pallets ÷ pallets_full_truck). Blank falls back to 18.</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[360px] overflow-auto">
          {routes.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <Label className="text-xs flex-1 truncate" title={r.name}>{r.code}</Label>
              <Input type="number" className="w-20 h-8" value={pallets[r.id] ?? ""} onChange={(e) => setPallets({ ...pallets, [r.id]: e.target.value })} />
            </div>
          ))}
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

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy === "save"}>{busy === "save" && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Save settings</Button>
      </div>
    </div>
  );
}
