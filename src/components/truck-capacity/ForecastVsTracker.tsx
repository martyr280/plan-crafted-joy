import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { KpiCard } from "@/components/shared/KpiCard";
import { ChevronDown, Download, Loader2, Target, TrendingUp, Gauge, CalendarRange } from "lucide-react";
import { getForecastVsTracker, exportForecastVsTracker } from "@/lib/truck-capacity.functions";
import { ACCURACY_DEFAULT_MADE_FROM, weekStartSunday } from "@/lib/truck-capacity/accuracy";

const HUB_ORDER = ["Dallas", "Birmingham", "Ocala"];

/** Whole percentage points; capacity fractions are the storage unit, points are the reading unit. */
const pts = (v: number | null | undefined, d = 0) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) * 100).toFixed(d);
const pctOf = (v: number | null | undefined) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : `${Math.round(Number(v) * 100)}%`;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function varianceClass(v: number): string {
  const a = Math.abs(v) * 100;
  if (a <= 10) return "bg-success/15 text-success";
  if (a <= 20) return "bg-warning/20 text-warning-foreground";
  return "bg-destructive/15 text-destructive";
}

/**
 * "Forecast vs Tracker": what Nelson forecast at each route's order cutoff versus
 * what the branches logged in the capacity tracker, by route and by week.
 * Read-only; the server applies rep scoping.
 */
export function ForecastVsTracker() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const thisSunday = weekStartSunday(todayISO);

  const [preset, setPreset] = useState<"4" | "8" | "12" | "custom">("8");
  const [customFrom, setCustomFrom] = useState(addDays(thisSunday, -56));
  const [customTo, setCustomTo] = useState(todayISO);
  const [madeOnFrom, setMadeOnFrom] = useState(ACCURACY_DEFAULT_MADE_FROM);
  const [includeSpecial, setIncludeSpecial] = useState(false);
  const [hub, setHub] = useState<string>("all");
  const [sortByVariance, setSortByVariance] = useState(true);
  const [page, setPage] = useState(0);
  const [runsOpen, setRunsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const from = preset === "custom" ? customFrom : addDays(thisSunday, -7 * (Number(preset) - 1));
  const to = preset === "custom" ? customTo : todayISO;

  const params = { from, to, madeOnFrom, includeSpecial, hub: hub === "all" ? null : hub };
  const fetchFvt = useServerFn(getForecastVsTracker);
  const q = useQuery({
    queryKey: ["forecast-vs-tracker", params],
    queryFn: () => fetchFvt({ data: params }),
  });

  const exportFn = useServerFn(exportForecastVsTracker);
  async function download() {
    setExporting(true);
    try {
      const { base64, filename } = await exportFn({ data: params });
      const bin = atob(base64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { toast.error(e?.message ?? "Export failed"); }
    setExporting(false);
  }

  const data = q.data as any;

  // Grid: weeks across the window as columns, routes grouped by hub as rows.
  const weeks = useMemo(() => {
    if (!data) return [] as string[];
    const out: string[] = [];
    let w = weekStartSunday(data.window.from);
    const end = weekStartSunday(data.window.to);
    while (w <= end) { out.push(w); w = addDays(w, 7); }
    return out;
  }, [data]);

  const gridRoutes = useMemo(() => {
    if (!data) return [] as Array<{ route_id: string; code: string; hub: string | null }>;
    const seen = new Map<string, { route_id: string; code: string; hub: string | null }>();
    for (const w of data.routeWeeks as any[]) {
      if (!seen.has(w.route_id)) seen.set(w.route_id, { route_id: w.route_id, code: w.code, hub: w.hub });
    }
    return Array.from(seen.values()).sort((a, b) => {
      const ha = HUB_ORDER.indexOf(a.hub ?? ""); const hb = HUB_ORDER.indexOf(b.hub ?? "");
      return (ha < 0 ? 99 : ha) - (hb < 0 ? 99 : hb) || a.code.localeCompare(b.code);
    });
  }, [data]);

  const cellByKey = useMemo(() => {
    const m = new Map<string, any>();
    for (const w of (data?.routeWeeks ?? []) as any[]) m.set(`${w.route_id}|${w.week_start}`, w);
    return m;
  }, [data]);

  const runRows = useMemo(() => {
    const rows = [...((data?.rows ?? []) as any[])];
    if (sortByVariance) rows.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    else rows.sort((a, b) => String(b.run_date).localeCompare(String(a.run_date)));
    return rows;
  }, [data, sortByVariance]);

  const pageRows = runRows.slice(page * 50, page * 50 + 50);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Window</Label>
            <Select value={preset} onValueChange={(v) => { setPreset(v as any); setPage(0); }}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="4">Last 4 weeks</SelectItem>
                <SelectItem value="8">Last 8 weeks</SelectItem>
                <SelectItem value="12">Last 12 weeks</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {preset === "custom" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input type="date" className="w-40" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input type="date" className="w-40" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Forecasts made on or after</Label>
            <Input type="date" className="w-40" value={madeOnFrom} onChange={(e) => setMadeOnFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Hub</Label>
            <Select value={hub} onValueChange={setHub}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All hubs</SelectItem>
                {HUB_ORDER.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-1">
            <Switch id="fvt-special" checked={includeSpecial} onCheckedChange={setIncludeSpecial} />
            <Label htmlFor="fvt-special" className="text-sm">Include special-run lanes</Label>
          </div>
          <Button variant="outline" size="sm" onClick={download} disabled={exporting} className="ml-auto">
            {exporting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Download className="w-4 h-4 mr-1" />}
            Export Excel
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Forecasts before this date were made while routes were still being seeded.
        </p>
      </Card>

      {/* Plain-language explainer */}
      <Card className="p-4 bg-muted/40">
        <p className="text-sm text-muted-foreground">
          Capacity is measured as a percent of a full truck. A point is one percentage point of that scale:
          if Nelson forecast 60% and the branch logged 77%, the miss is 17 points, with Nelson low.
          Forecast at cutoff is the last forecast Nelson recorded on or before the route's order cutoff for that run.
        </p>
      </Card>

      {q.isLoading && (
        <Card className="p-8 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading reconciliation…
        </Card>
      )}
      {q.error && <Card className="p-4 text-sm text-destructive">{(q.error as any)?.message ?? "Failed to load"}</Card>}

      {data && data.overall.n === 0 && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No scored runs in this window — upload the latest tracker in the Import tab or widen the window.
        </Card>
      )}

      {data && data.overall.n > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              label="Scored runs" value={data.overall.n}
              sub={`of ${data.coverage.routeDaysWithActuals} route-days with tracker actuals`}
              icon={<Target className="w-5 h-5" />}
            />
            <KpiCard
              label="Typical miss" value={`${pts(data.overall.mae, 1)} pts`}
              sub="average distance from the tracker" icon={<Gauge className="w-5 h-5" />}
            />
            <KpiCard
              label="Lean"
              value={`${pts(Math.abs(Number(data.overall.bias ?? 0)), 1)} pts ${Number(data.overall.bias ?? 0) >= 0 ? "high" : "low"}`}
              sub="+ means Nelson forecast above the tracker" icon={<TrendingUp className="w-5 h-5" />}
            />
            <KpiCard
              label="Within 15 pts" value={pctOf(data.overall.within15)}
              sub="share of runs close enough to act on" icon={<Target className="w-5 h-5" />}
            />
            <KpiCard
              label="Route-week miss" value={`${pts(data.weekLevel.mae, 1)} pts`}
              sub={`route-weeks with 2+ runs: ${data.weekLevel.n}`} icon={<CalendarRange className="w-5 h-5" />}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {HUB_ORDER.filter((h) => data.coverage.lastActualByHub?.[h])
              .map((h) => `${h} actuals end ${data.coverage.lastActualByHub[h]}`)
              .join(" · ") || "No tracker actuals in this window."}
          </p>

          {/* Route × week grid */}
          <Card className="p-4 overflow-x-auto">
            <h3 className="font-semibold mb-3">Forecast vs tracker by route and week</h3>
            <table className="text-xs border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="text-left sticky left-0 bg-card pr-3 pb-2 font-medium">Route</th>
                  {weeks.map((w) => (
                    <th key={w} className="px-1 pb-2 font-medium text-muted-foreground whitespace-nowrap">{w.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HUB_ORDER.concat(
                  Array.from(new Set(gridRoutes.map((r) => r.hub ?? "").filter((h) => h && !HUB_ORDER.includes(h)))),
                ).map((h) => {
                  const rs = gridRoutes.filter((r) => (r.hub ?? "") === h);
                  if (!rs.length) return null;
                  return (
                    <>
                      <tr key={`hub-${h}`}>
                        <td colSpan={weeks.length + 1} className="pt-3 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground sticky left-0 bg-card">{h}</td>
                      </tr>
                      {rs.map((r) => (
                        <tr key={r.route_id}>
                          <td className="sticky left-0 bg-card pr-3 py-1 font-medium whitespace-nowrap">{r.code}</td>
                          {weeks.map((w) => {
                            const cell = cellByKey.get(`${r.route_id}|${w}`);
                            if (!cell) return <td key={w} className="px-1 py-1" />;
                            return (
                              <td key={w} className="px-1 py-1">
                                <div
                                  className={`rounded px-1.5 py-1 text-center leading-tight ${varianceClass(cell.varianceMean)}`}
                                  title={`${r.code} · week of ${w} · ${cell.days} run${cell.days === 1 ? "" : "s"} scored`}
                                >
                                  <div className="whitespace-nowrap">F {pts(cell.forecastMean)} · T {pts(cell.actualMean)}</div>
                                  <div className="font-semibold">{cell.varianceMean >= 0 ? "+" : "−"}{pts(Math.abs(cell.varianceMean))}</div>
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </>
                  );
                })}
              </tbody>
            </table>
            <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-success/15 inline-block" /> within 10 pts</span>
              <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-warning/20 inline-block" /> within 20 pts</span>
              <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-destructive/15 inline-block" /> more than 20 pts</span>
              <span>Blank = no scored runs. F = forecast at cutoff, T = tracker.</span>
            </div>
          </Card>

          {/* By route */}
          <Card className="p-4">
            <h3 className="font-semibold mb-3">By route</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead className="text-right">Scored runs</TableHead>
                  <TableHead className="text-right">Typical miss (pts)</TableHead>
                  <TableHead className="text-right">Lean (pts)</TableHead>
                  <TableHead className="text-right">Within 15 pts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data.byRoute as any[]).map((r) => (
                  <TableRow key={r.route_id}>
                    <TableCell className="font-medium">
                      {r.code}
                      {r.n < 3 && <Badge variant="outline" className="ml-2 text-[10px]">n&lt;3 · not yet meaningful</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{r.n}</TableCell>
                    <TableCell className="text-right">{pts(r.mae, 1)}</TableCell>
                    <TableCell className="text-right">
                      {pts(Math.abs(Number(r.bias ?? 0)), 1)} {Number(r.bias ?? 0) >= 0 ? "high" : "low"}
                    </TableCell>
                    <TableCell className="text-right">{pctOf(r.within15)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* Runs detail */}
          <Collapsible open={runsOpen} onOpenChange={setRunsOpen}>
            <Card className="p-4">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="px-0">
                  <ChevronDown className={`w-4 h-4 mr-1 transition-transform ${runsOpen ? "rotate-180" : ""}`} />
                  Runs detail ({runRows.length})
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-3">
                <Button variant="outline" size="sm" onClick={() => { setSortByVariance((s) => !s); setPage(0); }}>
                  Sort by {sortByVariance ? "run date" : "variance"}
                </Button>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Route</TableHead>
                      <TableHead>Run date</TableHead>
                      <TableHead>Cutoff</TableHead>
                      <TableHead>Forecast made on</TableHead>
                      <TableHead className="text-right">Forecast %</TableHead>
                      <TableHead className="text-right">Tracker %</TableHead>
                      <TableHead className="text-right">Variance pts</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Guard</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((r) => (
                      <TableRow key={`${r.route_id}-${r.run_date}`}>
                        <TableCell className="font-medium">{r.code}</TableCell>
                        <TableCell>{r.run_date}</TableCell>
                        <TableCell>
                          {r.cutoff_date}
                          {!r.cutoff_known && <span className="text-muted-foreground text-xs"> (est)</span>}
                        </TableCell>
                        <TableCell>
                          {r.made_on} <span className="text-muted-foreground text-xs">({r.lead_days}d)</span>
                          {r.after_cutoff && <Badge variant="outline" className="ml-1 text-[10px]">after cutoff</Badge>}
                        </TableCell>
                        <TableCell className="text-right">{pts(r.forecast)}</TableCell>
                        <TableCell className="text-right">{pts(r.actual)}</TableCell>
                        <TableCell className="text-right font-medium">
                          {r.variance >= 0 ? "+" : "−"}{pts(Math.abs(r.variance))}
                        </TableCell>
                        <TableCell className="text-xs">{r.method ?? "—"}</TableCell>
                        <TableCell className="text-xs">{r.guard ? "Yes" : ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {runRows.length > 50 && (
                  <div className="flex items-center gap-2 text-sm">
                    <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                    <span className="text-muted-foreground">
                      {page * 50 + 1}–{Math.min(runRows.length, page * 50 + 50)} of {runRows.length}
                    </span>
                    <Button variant="outline" size="sm" disabled={(page + 1) * 50 >= runRows.length} onClick={() => setPage((p) => p + 1)}>Next</Button>
                  </div>
                )}
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </>
      )}
    </div>
  );
}
