import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { toast } from "sonner";
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock, Download,
  Loader2, MapPin, Printer, RefreshCw, Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useModuleView } from "@/lib/usage-log";
import {
  useDriverTimeWeek, useUpdateDriverTimeEvent, useSetPaycomHours, useRunDriverTimeSweep,
  useDriverTimeConfig, useSaveDriverTimeConfig, useDriverPayRates, useImportDriverPayRates,
  useSamsaraDiagnostics,
} from "@/hooks/useDriverTime";
import { CENTRAL_TZ, dateStrInTz } from "@/lib/driver-time/tz";

export const Route = createFileRoute("/_app/driver-time")({
  head: () => ({
    meta: [
      { title: "Driver Warehouse Time — Nelson AI for NDI" },
      { name: "description", content: "Automated audit of driver non-driving time parked at NDI warehouses, with weekly review and cost estimates." },
      { property: "og:title", content: "Driver Warehouse Time — Nelson AI for NDI" },
      { property: "og:description", content: "Automated audit of driver non-driving time parked at NDI warehouses, with weekly review and cost estimates." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DriverTimePage,
});

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function mondayOf(d: Date) {
  const x = new Date(`${dateStrInTz(d, CENTRAL_TZ)}T00:00:00Z`);
  const dow = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return x.toISOString().slice(0, 10);
}

function shiftWeek(weekStart: string, weeks: number) {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

function hm(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CENTRAL_TZ });
}

function dayLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

const STATUS_STYLE: Record<string, string> = {
  new: "bg-destructive/10 text-destructive border-destructive/30",
  reviewed: "bg-primary/10 text-primary border-primary/30",
  excused: "bg-muted text-muted-foreground",
};

function DriverTimePage() {
  useModuleView("driver-time");
  const { hasAnyRole } = useAuth();
  const canView = hasAnyRole(["admin", "ops_logistics", "ops_logistics_admin"] as any);
  const isAdmin = hasAnyRole(["admin"] as any);

  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const weekQ = useDriverTimeWeek(weekStart, canView);
  const sweep = useRunDriverTimeSweep();

  const data = weekQ.data;
  const drivers = data?.drivers ?? [];
  const totals = data?.totals;

  const csv = useMemo(() => {
    const rows: string[][] = [[
      "driver", "date", "start", "end", "duration_min", "warehouse", "statuses",
      "location_source", "needs_review", "status", "notes",
    ]];
    for (const d of drivers) {
      for (const ev of d.events as any[]) {
        rows.push([
          d.driverName, ev.event_date, ev.start_ts, ev.end_ts, String(ev.duration_min),
          ev.address_name ?? "", (ev.statuses ?? []).join("/"), ev.location_source,
          ev.needs_review ? "yes" : "no", ev.status, (ev.notes ?? "").replace(/"/g, "'"),
        ]);
      }
    }
    return rows.map((r) => r.map((c) => `"${String(c ?? "")}"`).join(",")).join("\n");
  }, [drivers]);

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `driver-warehouse-time-${weekStart}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!canView) {
    return (
      <div className="p-6">
        <ModuleHeader title="Driver Warehouse Time" description="Logistics access required." />
        <Card className="p-6 text-sm text-muted-foreground">
          This module is restricted to logistics staff and administrators.
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6">
      <ModuleHeader
        title="Driver Warehouse Time"
        description="Non-driving on-duty blocks parked inside a warehouse geofence, detected from Samsara hours-of-service logs."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={downloadCsv} disabled={!drivers.length}>
              <Download className="w-4 h-4 mr-1" /> CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!drivers.length}>
              <Printer className="w-4 h-4 mr-1" /> Print / PDF
            </Button>
            <Button
              size="sm"
              onClick={() =>
                sweep.mutate(undefined, {
                  onSuccess: (r: any) =>
                    r?.ok
                      ? toast.success(`Sweep complete — ${r.eventsFound} event(s) across ${r.driversScanned} driver(s)`)
                      : toast.error(r?.error ?? "Sweep failed"),
                  onError: (e: any) => toast.error(e?.message ?? "Sweep failed"),
                })
              }
              disabled={sweep.isPending}
            >
              {sweep.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              Run sweep
            </Button>
          </>
        }
      />

      <div className="flex items-center gap-2 mb-4">
        <Button variant="outline" size="icon" onClick={() => setWeekStart(shiftWeek(weekStart, -1))}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="text-sm font-medium">
          Week of {dayLabel(weekStart)}{data ? ` – ${dayLabel(data.weekEnd)}` : ""}
        </div>
        <Button variant="outline" size="icon" onClick={() => setWeekStart(shiftWeek(weekStart, 1))}>
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <KpiCard label="Drivers flagged" value={String(totals?.drivers ?? 0)} icon={<Users className="w-5 h-5" />} />
        <KpiCard label="Flagged hours" value={`${totals?.flaggedHours ?? 0}`} icon={<Clock className="w-5 h-5" />} />
        <KpiCard label="Needs review" value={String(totals?.needsReview ?? 0)} icon={<AlertTriangle className="w-5 h-5" />} />
        <KpiCard
          label="Estimated cost"
          value={isAdmin ? money(totals?.estimatedCost ?? 0) : "—"}
          icon={<CheckCircle2 className="w-5 h-5" />}
        />

      </div>

      {isAdmin && (totals?.driversWithoutRate ?? 0) > 0 && (
        <Card className="p-3 mb-4 text-xs text-muted-foreground border-warning/40">
          {totals?.driversWithoutRate} driver(s) have no hourly rate on file, so their time is excluded from the cost
          estimate rather than valued at zero. Overtime is approximated from Samsara hours unless Paycom hours are entered.
        </Card>
      )}

      <Tabs defaultValue="report">
        <TabsList>
          <TabsTrigger value="report">Weekly report</TabsTrigger>
          <TabsTrigger value="runs">Sweeps</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          {isAdmin && <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>}
        </TabsList>


        <TabsContent value="report" className="mt-4 space-y-4">
          {weekQ.isLoading && (
            <Card className="p-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading week…
            </Card>
          )}
          {!weekQ.isLoading && !drivers.length && (
            <Card className="p-6 text-sm text-muted-foreground">
              No warehouse dwell events for this week. Run a sweep, or confirm the warehouse geofences and threshold in
              Settings.
            </Card>
          )}
          {hubGroups.map((g: any) => (
            <Card key={g.hub} className="p-0 overflow-hidden">
              <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                <div className="text-sm font-semibold">{g.hub}</div>
                <div className="text-xs text-muted-foreground">
                  {g.drivers.length} driver{g.drivers.length === 1 ? "" : "s"} · {hm(g.flaggedMinutes)} flagged
                </div>
              </div>
              <div className="space-y-4 p-3">
                {g.drivers.map((d: any) => (
                  <DriverCard key={d.driverId} driver={d} weekStart={weekStart} isAdmin={!!data?.isAdmin} />
                ))}
              </div>
            </Card>
          ))}

        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Week</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Drivers</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.runs ?? []).map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">{new Date(r.started_at).toLocaleString("en-US", { timeZone: CENTRAL_TZ })}</TableCell>
                    <TableCell className="text-xs">{r.week_start} → {r.week_end}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "completed" ? "secondary" : "destructive"}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{r.drivers_scanned}</TableCell>
                    <TableCell className="text-right">{r.events_found}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[380px] truncate">{r.error ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {!(data?.runs ?? []).length && (
                  <TableRow><TableCell colSpan={6} className="text-sm text-muted-foreground">No sweeps yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <DriverTimeSettings isAdmin={isAdmin} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="diagnostics" className="mt-4">
            <DiagnosticsTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}


/* ------------------------------------------------------------- driver card */

function DriverCard({ driver, weekStart, isAdmin }: { driver: any; weekStart: string; isAdmin: boolean }) {
  const update = useUpdateDriverTimeEvent();
  const paycom = useSetPaycomHours();
  const [hours, setHours] = useState("");

  const byDay = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const ev of driver.events as any[]) {
      const arr = m.get(ev.event_date) ?? [];
      arr.push(ev);
      m.set(ev.event_date, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [driver.events]);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="font-semibold">{driver.driverName}</div>
          <div className="text-xs text-muted-foreground">
            {driver.events.length} block(s) · {hm(driver.flaggedMinutes)} of non-driving warehouse time this week
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {isAdmin && (
            <span className="text-muted-foreground">
              {driver.cost.cost === null
                ? driver.cost.note
                : `${money(driver.cost.cost)} est. (${driver.cost.multiplier}× · ${driver.cost.hoursSource} hours)`}
            </span>
          )}
          <div className="flex items-center gap-1">
            <Input
              className="h-8 w-28"
              placeholder="Paycom hrs"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const n = hours.trim() === "" ? null : Number(hours);
                if (n !== null && !Number.isFinite(n)) return toast.error("Enter a number of hours");
                paycom.mutate(
                  { driverId: driver.driverId, weekStart, paycomHours: n },
                  { onSuccess: () => toast.success("Paycom hours saved"), onError: (e: any) => toast.error(e?.message) },
                );
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {byDay.map(([date, events]) => (
          <div key={date}>
            <div className="text-xs font-medium text-muted-foreground mb-1">{dayLabel(date)}</div>
            <div className="rounded-md border divide-y">
              {events.map((ev: any) => (
                <div key={ev.id} className="p-3 flex flex-wrap items-center gap-3 text-sm">
                  <div className="font-mono text-xs w-40">{clock(ev.start_ts)} – {clock(ev.end_ts)}</div>
                  <div className="font-medium w-24">{hm(ev.duration_min)}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-[200px]">
                    <MapPin className="w-3 h-3" />
                    {ev.address_name ?? "location unresolved"}
                    {ev.location_source !== "log" && (
                      <Badge variant="outline" className="ml-1 text-[10px]">{ev.location_source}</Badge>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{(ev.statuses ?? []).join(" / ")}</div>
                  {ev.needs_review && (
                    <Badge variant="outline" className="text-[10px] border-warning/50">needs review</Badge>
                  )}
                  <Badge variant="outline" className={`text-[10px] ${STATUS_STYLE[ev.status] ?? ""}`}>{ev.status}</Badge>
                  <div className="ml-auto flex items-center gap-1">
                    {(["new", "reviewed", "excused"] as const).map((s) => (
                      <Button
                        key={s}
                        size="sm"
                        variant={ev.status === s ? "secondary" : "ghost"}
                        onClick={() => update.mutate({ id: ev.id, status: s })}
                      >
                        {s}
                      </Button>
                    ))}
                  </div>
                  <Input
                    className="h-8 w-full sm:w-64"
                    placeholder="Note"
                    defaultValue={ev.notes ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value;
                      if (v !== (ev.notes ?? "")) update.mutate({ id: ev.id, status: ev.status, notes: v || null });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- settings */

function DriverTimeSettings({ isAdmin }: { isAdmin: boolean }) {
  const cfgQ = useDriverTimeConfig();
  const save = useSaveDriverTimeConfig();
  const ratesQ = useDriverPayRates(isAdmin);
  const importRates = useImportDriverPayRates();

  const settings = cfgQ.data?.settings;
  const [threshold, setThreshold] = useState<string>("");
  const [mergeGap, setMergeGap] = useState<string>("");
  const [patterns, setPatterns] = useState<string>("");
  const [ratesText, setRatesText] = useState("");

  const selected = new Set<string>(settings?.warehouseAddressIds ?? []);

  function toggleAddress(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    save.mutate({ warehouseAddressIds: Array.from(next) }, {
      onSuccess: () => toast.success("Warehouse geofences updated"),
      onError: (e: any) => toast.error(e?.message),
    });
  }

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="font-semibold text-sm">Detection</div>
        {cfgQ.data?.error && (
          <div className="text-xs text-destructive">
            Samsara data unavailable: {cfgQ.data.error} — check the API token scopes in Settings → Integrations.
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Flag blocks of at least (minutes)</Label>
            <Input
              value={threshold || String(settings?.thresholdMinutes ?? 90)}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Merge blocks split by movement under (minutes)</Label>
            <Input
              value={mergeGap || String(settings?.mergeGapMinutes ?? 10)}
              onChange={(e) => setMergeGap(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label className="text-xs">Excluded driver name patterns (one per line)</Label>
          <Textarea
            rows={3}
            value={patterns || (settings?.excludedDriverNamePatterns ?? []).join("\n")}
            onChange={(e) => setPatterns(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Non-human Samsara accounts (shared LTL / warehouse logins) belong here; they otherwise dominate the report.
          </p>
        </div>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={() =>
            save.mutate(
              {
                thresholdMinutes: Number(threshold || settings?.thresholdMinutes || 90),
                mergeGapMinutes: Number(mergeGap || settings?.mergeGapMinutes || 10),
                excludedDriverNamePatterns: (patterns || (settings?.excludedDriverNamePatterns ?? []).join("\n"))
                  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
              },
              { onSuccess: () => toast.success("Settings saved"), onError: (e: any) => toast.error(e?.message) },
            )
          }
        >
          Save detection settings
        </Button>
      </Card>

      <Card className="p-4">
        <div className="font-semibold text-sm mb-2">Warehouse geofences</div>
        {cfgQ.isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading Samsara addresses…
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto divide-y">
            {(cfgQ.data?.addresses ?? []).map((a: any) => (
              <label key={a.id} className="flex items-center gap-2 py-2 text-sm cursor-pointer">
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleAddress(a.id)} />
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-muted-foreground">{a.formattedAddress ?? ""}</span>
              </label>
            ))}
            {!(cfgQ.data?.addresses ?? []).length && (
              <div className="text-sm text-muted-foreground py-2">No Samsara addresses visible.</div>
            )}
          </div>
        )}
      </Card>

      {isAdmin && (
        <Card className="p-4 space-y-3">
          <div className="font-semibold text-sm">Driver pay rates (admin only)</div>
          <Textarea
            rows={5}
            placeholder={"Driver Name, 24.50\nAnother Driver, 26"}
            value={ratesText}
            onChange={(e) => setRatesText(e.target.value)}
          />
          <Button
            size="sm"
            disabled={importRates.isPending || !ratesText.trim()}
            onClick={() =>
              importRates.mutate(
                { text: ratesText },
                {
                  onSuccess: (r: any) => {
                    toast.success(`Imported ${r.imported} rate(s)`);
                    if (r.unmatched?.length) toast.error(`${r.unmatched.length} line(s) unmatched`);
                    setRatesText("");
                  },
                  onError: (e: any) => toast.error(e?.message),
                },
              )
            }
          >
            Import rates
          </Button>
          <div className="rounded-md border divide-y max-h-64 overflow-y-auto">
            {(ratesQ.data?.rates ?? []).map((r: any) => (
              <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>{r.driver_name ?? r.driver_id}</span>
                <span className="text-muted-foreground text-xs">
                  {money(Number(r.hourly_rate))}/hr from {r.effective_date}
                </span>
              </div>
            ))}
            {!(ratesQ.data?.rates ?? []).length && (
              <div className="px-3 py-2 text-sm text-muted-foreground">No rates on file.</div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function FunnelRow({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
      <div>
        <div className="text-sm">{label}</div>
        {note && <div className="text-xs text-muted-foreground">{note}</div>}
      </div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}

type Rag = "green" | "yellow" | "red" | "none";

function ragOf(min: number, greenUnder: number, redAtOrOver: number): Rag {
  if (!min) return "none";
  if (min >= redAtOrOver) return "red";
  if (min >= greenUnder) return "yellow";
  return "green";
}

const RAG_CLASS: Record<Rag, string> = {
  green: "text-success bg-success/10",
  yellow: "text-warning bg-warning/10",
  red: "text-destructive bg-destructive/10",
  none: "text-muted-foreground",
};

/** Parse a numeric input to null when empty or non-numeric. */
function parseMinInput(raw: string, floor: number): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.max(floor, Math.round(n));
}


function diagnosticsVerdict(d: any): { ok: boolean; text: string } {
  if (d.fatalError) return { ok: false, text: `Diagnostics could not run: ${d.fatalError}` };
  const f = d.funnel;
  if (f.eventsEmitted > 0) {
    const withEvents = (d.drivers ?? []).filter((r: any) => r.eventsEmitted > 0).length;
    return {
      ok: true,
      text: `Pipeline healthy — ${f.eventsEmitted} event(s) detected across ${withEvents} driver(s).`,
    };
  }
  if (f.segmentsFetched === 0)
    return { ok: false, text: "Samsara returned no HOS logs for this window. Check the Samsara scopes list below." };
  if (!(d.statusVocabulary ?? []).some((s: any) => s.countedAsWarehouseTime))
    return {
      ok: false,
      text: "Samsara is sending duty-status values the detector does not recognise. The engine only counts onDuty and yardMove — see the raw duty-status vocabulary below.",
    };
  if ((d.fences ?? []).some((x: any) => x.kind === "none"))
    return {
      ok: false,
      text: "One or more selected warehouse addresses have no geofence shape in Samsara, so nothing can ever match them.",
    };
  if (f.blocksBuilt === 0) return { ok: false, text: "Logs arrived but no non-driving blocks were built." };
  if (f.blocksInsideFence === 0)
    return {
      ok: false,
      text: "Blocks were built and located, but none fell inside a selected geofence. Check the nearest-fence distances in the driver grid.",
    };
  if (f.blocksOverThreshold === 0)
    return {
      ok: false,
      text: `Blocks matched a warehouse but none reached the ${d.settings.thresholdMinutes}-minute threshold.`,
    };
  if (f.blocksOverThresholdAndInsideFence === 0)
    return {
      ok: false,
      text: `Blocks were located inside a warehouse and other blocks cleared the ${d.settings.thresholdMinutes}-minute threshold, but no single block did both.`,
    };

  return {
    ok: false,
    text: "Blocks cleared the threshold inside a geofence but no events were emitted — this is unexpected, check the driver grid.",
  };

}

function DiagnosticsTab() {
  const diag = useSamsaraDiagnostics();
  const [lookbackDays, setLookbackDays] = useState(8);
  const d = diag.data as any | undefined;
  const [greenUnderRaw, setGreenUnder] = useState<number | null>(45);
  const [redAtOrOverRaw, setRedAtOrOver] = useState<number | null>(null);
  const redAtOrOver = Math.max(2, redAtOrOverRaw ?? d?.settings?.thresholdMinutes ?? 90);
  const greenUnder = Math.min(greenUnderRaw ?? 45, Math.max(1, redAtOrOver - 1));

  const verdict = d ? diagnosticsVerdict(d) : null;

  function downloadDiagCsv() {
    if (!d) return;
    const header = [
      "Driver", "Activation", "Excluded", "Segs", "w/ GPS", "Driving (min)",
      "On-duty non-driving (min)", "Longest block (min)", "RAG",
      "Location source", "Matched fence", "Nearest fence", "Nearest fence (m)", "Events",
    ];
    const rows = [header, ...d.drivers.map((r: any) => [
      r.driverName, r.activationStatus ?? "", r.excluded ? "yes" : "no",
      String(r.segments), String(r.segmentsWithCoords), String(r.drivingMin),
      String(r.onDutyNonDrivingMin), String(r.longestNonDrivingMin),
      r.excluded ? "" : ragOf(r.longestNonDrivingMin, greenUnder, redAtOrOver),
      r.longestBlockLocationSource, r.matchedFenceName ?? "", r.nearestFenceName ?? "",
      r.nearestFenceMeters === null ? "" : String(r.nearestFenceMeters), String(r.eventsEmitted),
    ])];
    const csv = (rows as string[][]).map((r) => r.map((c) => `"${String(c ?? "")}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `samsara-diagnostics-${String(d.ranAt).slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="dt-lookback">Lookback days</Label>
            <Input
              id="dt-lookback"
              type="number"
              min={1}
              max={30}
              className="w-28"
              value={lookbackDays}
              onChange={(e) => setLookbackDays(Number(e.target.value) || 8)}
            />
          </div>
          <Button
            onClick={() =>
              diag.mutate({ lookbackDays }, {
                onError: (e: any) => toast.error(e?.message ?? "Diagnostics failed"),
              })
            }
            disabled={diag.isPending}
          >
            {diag.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Run diagnostics
          </Button>
          {d && (
            <Button variant="outline" onClick={downloadDiagCsv}>
              <Download className="mr-2 h-4 w-4" /> CSV
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Read-only. Pulls the same Samsara window the sweep uses and writes nothing.
          </p>
        </div>
      </Card>

      {verdict && (
        <Card
          className={
            verdict.ok
              ? "border-success/50 bg-success/10 p-5"
              : "border-destructive/50 bg-destructive/10 p-5"
          }
        >
          <div className={`flex items-start gap-3 ${verdict.ok ? "text-success" : "text-destructive"}`}>
            {verdict.ok ? <CheckCircle2 className="mt-0.5 h-6 w-6" /> : <AlertTriangle className="mt-0.5 h-6 w-6" />}
            <p className="text-lg font-semibold leading-snug">{verdict.text}</p>
          </div>
        </Card>
      )}

      {!d && !diag.isPending && (
        <Card className="p-6 text-sm text-muted-foreground">
          Run diagnostics to see the raw Samsara data behind the last sweep.
        </Card>
      )}

      {d && !d.fatalError && (
        <>
          {d.warnings?.length > 0 && (
            <Card className="border-destructive/40 bg-destructive/5 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" /> Warnings
              </div>
              <ul className="list-inside list-disc space-y-1 text-sm">
                {d.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
              </ul>
            </Card>
          )}

          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold">Window</h3>
            <p className="text-xs text-muted-foreground">
              {new Date(d.windowStartIso).toLocaleString("en-US", { timeZone: CENTRAL_TZ })} →{" "}
              {new Date(d.windowEndIso).toLocaleString("en-US", { timeZone: CENTRAL_TZ })} CT ({d.lookbackDays} days) ·
              threshold {d.settings.thresholdMinutes} min · merge gap {d.settings.mergeGapMinutes} min
            </p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Pipeline funnel</h3>
              <FunnelRow label="Drivers in Samsara (incl. deactivated)" value={d.funnel.driversOnRoster} />
              <FunnelRow label="After exclusions" value={d.funnel.driversAfterExclusions} />
              <FunnelRow label="HOS segments fetched" value={d.funnel.segmentsFetched} />
              <FunnelRow label="Segments with coordinates" value={d.funnel.segmentsWithCoords} />
              <FunnelRow label="GPS fallback samples" value={d.funnel.gpsSamples} />
              <FunnelRow label="Non-driving blocks built" value={d.funnel.blocksBuilt} />
              <FunnelRow
                label={`Blocks ≥ ${d.settings.thresholdMinutes} min`}
                value={d.funnel.blocksOverThreshold}
              />
              <FunnelRow label="Blocks inside a warehouse fence" value={d.funnel.blocksInsideFence} />
              <FunnelRow
                label="Blocks both in-fence and over threshold"
                value={d.funnel.blocksOverThresholdAndInsideFence}
              />

              <FunnelRow label="Events the engine would emit" value={d.funnel.eventsEmitted} />
            </Card>

            <Card className="p-4">
              <h3 className="mb-2 text-sm font-semibold">Samsara scopes</h3>
              <div className="space-y-2">
                {d.probes.map((p: any) => (
                  <div key={p.endpoint} className="flex items-start gap-2 text-sm">
                    {p.ok
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                      : <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />}
                    <div>
                      <div>{p.endpoint}</div>
                      <div className="text-xs text-muted-foreground">{p.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold">Raw duty-status vocabulary</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Exactly what Samsara sent. A status the engine does not count can never produce an event.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Segments</TableHead>
                  <TableHead className="text-right">Minutes</TableHead>
                  <TableHead>Counted as warehouse time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.statusVocabulary.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-sm text-muted-foreground">No logs in the window.</TableCell></TableRow>
                )}
                {d.statusVocabulary.map((s: any) => (
                  <TableRow key={s.status}>
                    <TableCell className="font-mono text-xs">{s.status}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.segments}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.minutes}</TableCell>
                    <TableCell>
                      {s.countedAsWarehouseTime
                        ? <Badge variant="secondary">yes</Badge>
                        : <Badge variant="outline">no</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold">Selected warehouse geofences</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Shape</TableHead>
                  <TableHead className="text-right">Radius (m)</TableHead>
                  <TableHead>Center</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.fences.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-sm text-muted-foreground">No warehouse addresses selected in Settings.</TableCell></TableRow>
                )}
                {d.fences.map((f: any) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <div className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-muted-foreground" />{f.name}</div>
                      <div className="text-xs text-muted-foreground">{f.formattedAddress ?? ""}</div>
                    </TableCell>
                    <TableCell>
                      {f.kind === "none"
                        ? <Badge variant="destructive">none</Badge>
                        : <Badge variant="outline">{f.kind}{f.kind === "polygon" ? ` (${f.vertexCount})` : ""}</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{f.radiusMeters ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {f.latitude !== null && f.longitude !== null ? `${f.latitude.toFixed(5)}, ${f.longitude.toFixed(5)}` : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold">Per-driver detail</h3>
            <div className="mb-3 flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label htmlFor="dt-rag-green">Green under (min)</Label>
                <Input
                  id="dt-rag-green"
                  type="number"
                  min={1}
                  className="w-28"
                  value={greenUnder}
                  onChange={(e) => setGreenUnder(parseMinInput(e.target.value, 1))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dt-rag-red">Red at or over (min)</Label>
                <Input
                  id="dt-rag-red"
                  type="number"
                  min={2}
                  className="w-28"
                  value={redAtOrOver}
                  onChange={(e) => setRedAtOrOver(parseMinInput(e.target.value, 2))}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded px-2 py-1 text-success bg-success/10">&lt; {greenUnder} min</span>
                <span className="rounded px-2 py-1 text-warning bg-warning/10">
                  {greenUnder}–{Math.max(greenUnder, redAtOrOver - 1)} min
                </span>
                <span className="rounded px-2 py-1 text-destructive bg-destructive/10">≥ {redAtOrOver} min</span>
                <span className="rounded px-2 py-1 text-muted-foreground bg-muted">no data</span>
              </div>

            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Driver</TableHead>
                    <TableHead className="text-right">Segs</TableHead>
                    <TableHead className="text-right">w/ GPS</TableHead>
                    <TableHead className="text-right">Driving</TableHead>
                    <TableHead className="text-right">On-duty non-driving</TableHead>
                    <TableHead className="text-right">Longest block</TableHead>
                    <TableHead>Location source</TableHead>
                    <TableHead>Matched fence</TableHead>
                    <TableHead>Nearest fence</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.drivers.map((r: any) => (
                    <TableRow key={r.driverId} className={r.excluded ? "opacity-50" : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Users className="h-3.5 w-3.5 text-muted-foreground" />
                          {r.driverName}
                          {r.excluded && <Badge variant="outline">excluded</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">{r.activationStatus ?? ""}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.segments}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.segmentsWithCoords}</TableCell>
                      <TableCell className="text-right tabular-nums">{hm(r.drivingMin)}</TableCell>
                      <TableCell className="text-right tabular-nums">{hm(r.onDutyNonDrivingMin)}</TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${
                          r.excluded ? "text-muted-foreground" : RAG_CLASS[ragOf(r.longestNonDrivingMin, greenUnder, redAtOrOver)]
                        }`}
                      >
                        {r.longestNonDrivingMin ? hm(r.longestNonDrivingMin) : "—"}
                        {r.longestBlockStartIso && (
                          <div className="text-xs text-muted-foreground">
                            {clock(r.longestBlockStartIso)}–{clock(r.longestBlockEndIso)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{r.longestBlockLocationSource}</TableCell>
                      <TableCell className="text-xs">{r.matchedFenceName ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {r.nearestFenceName ? `${r.nearestFenceName} · ${r.nearestFenceMeters} m` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.eventsEmitted}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Longest block is computed without the ELD-day split the detector applies, so a block spanning midnight
              may read longer here than the sweep sees.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
