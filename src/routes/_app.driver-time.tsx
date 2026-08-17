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
} from "@/hooks/useDriverTime";

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
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function dayLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
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
          {drivers.map((d: any) => (
            <DriverCard key={d.driverId} driver={d} weekStart={weekStart} isAdmin={!!data?.isAdmin} />
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
                    <TableCell className="text-xs">{new Date(r.started_at).toLocaleString()}</TableCell>
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
