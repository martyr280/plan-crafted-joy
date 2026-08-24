import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, Hammer, Loader2, MapPin, Printer, RefreshCw, Send, Truck, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useModuleView } from "@/lib/usage-log";
import { buildLoadSheet } from "@/lib/dispatch/loadsheet";
import {
  useAddressQueue, useApproveAndPush, useBuildRunNow, useCancelRun, useDispatchRun, useDispatchRuns,
  useDispatchSettings, useDriverMappings, useImportSequencePaste, usePreviewDelta, useResolveAddress,
  useSaveDispatchSettings, useSaveDriverMapping, useSequenceTemplate, useSuggestAddressMatches,
} from "@/hooks/useDispatch";

export const Route = createFileRoute("/_app/dispatch")({
  head: () => ({
    meta: [
      { title: "Route Dispatch — Nelson AI for NDI" },
      { name: "description", content: "Build Samsara delivery routes from P21 orders with shadow-mode review, address verification and stop sequencing." },
      { property: "og:title", content: "Route Dispatch — Nelson AI for NDI" },
      { property: "og:description", content: "Build Samsara delivery routes from P21 orders with shadow-mode review, address verification and stop sequencing." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DispatchPage,
});

const num = (n: unknown) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 });

function timeLocal(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    planned: "bg-muted text-muted-foreground",
    pushed: "bg-primary/15 text-primary",
    locked: "bg-amber-500/15 text-amber-600",
    cancelled: "bg-destructive/15 text-destructive",
    error: "bg-destructive/15 text-destructive",
  };
  return <Badge className={map[status] ?? "bg-muted text-muted-foreground"} variant="secondary">{status}</Badge>;
}

function DispatchPage() {
  const { hasRole } = useAuth();
  useModuleView("dispatch");
  const canWrite = hasRole("admin") || hasRole("ops_logistics_admin");
  const isAdmin = hasRole("admin");

  const runs = useDispatchRuns();
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const rows: any[] = runs.data?.rows ?? [];
  const byHub = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of rows) {
      const list = m.get(r.hub) ?? [];
      list.push(r);
      m.set(r.hub, list);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const totals = useMemo(() => {
    const all: any[] = rows.flatMap((r: any) => r.runs);
    return {
      enabled: rows.filter((r: any) => r.enabled).length,
      planned: all.filter((r: any) => r.status === "planned").length,
      pushed: all.filter((r: any) => r.status === "pushed").length,
      held: all.reduce((n: number, r: any) => n + r.stopsHeld, 0),
    };
  }, [rows]);

  return (
    <div>
      <ModuleHeader
        title="Route Dispatch"
        description="P21 orders → Samsara routes. Shadow mode by default: nothing reaches Samsara until a route is enabled and a run is approved."
        actions={
          <Button variant="outline" size="sm" onClick={() => runs.refetch()} disabled={runs.isFetching}>
            {runs.isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        }
      />

      {runs.data && !runs.data.viewAvailable && (
        <Card className="p-4 mb-4 border-amber-500/40 bg-amber-500/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-sm">
              <div className="font-medium">Dispatch source view not marked available</div>
              <p className="text-muted-foreground mt-1">
                Builds will fail until Kevin publishes <code className="text-xs">{runs.data.settings.viewName}</code> and an admin flips
                “Source view available” in Settings. Everything else on this page still works.
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <KpiCard title="Routes enabled" value={String(totals.enabled)} icon={<Truck className="w-4 h-4" />} />
        <KpiCard title="Runs planned" value={String(totals.planned)} icon={<Clock className="w-4 h-4" />} />
        <KpiCard title="Runs pushed" value={String(totals.pushed)} icon={<Send className="w-4 h-4" />} />
        <KpiCard title="Stops held" value={String(totals.held)} icon={<AlertTriangle className="w-4 h-4" />} />
      </div>

      <Tabs defaultValue="board">
        <TabsList>
          <TabsTrigger value="board">Runs board</TabsTrigger>
          <TabsTrigger value="addresses">Address review</TabsTrigger>
          <TabsTrigger value="sequence">Sequence editor</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="mt-4 space-y-6">
          {runs.isLoading && <Card className="p-6 text-sm text-muted-foreground">Loading routes…</Card>}
          {byHub.map(([hub, list]) => (
            <div key={hub}>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">{hub}</h2>
              <Card className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Route</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Next cutoff</TableHead>
                      <TableHead>Runs</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((r: any) => (
                      <RouteRow key={r.routeId} route={r} canWrite={canWrite} onOpenRun={setOpenRunId} />
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="addresses" className="mt-4">
          <AddressQueueTab canWrite={canWrite} />
        </TabsContent>

        <TabsContent value="sequence" className="mt-4">
          <SequenceTab routes={rows} canWrite={canWrite} />
        </TabsContent>

        <TabsContent value="settings" className="mt-4 space-y-4">
          <SettingsCard routes={rows} isAdmin={isAdmin} />
          <DriverMappingCard routes={rows} canWrite={canWrite} />
        </TabsContent>
      </Tabs>

      <RunDetailDialog runId={openRunId} onClose={() => setOpenRunId(null)} canWrite={canWrite} />
    </div>
  );
}

/* ------------------------------------------------------------- board row */

function RouteRow({ route, canWrite, onOpenRun }: { route: any; canWrite: boolean; onOpenRun: (id: string) => void }) {
  const build = useBuildRunNow();
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{route.code}</div>
        <div className="text-xs text-muted-foreground">{route.name}</div>
      </TableCell>
      <TableCell>
        {route.enabled ? (
          <Badge variant="secondary" className="bg-primary/15 text-primary">{route.autoPush ? "auto-push" : "enabled"}</Badge>
        ) : (
          <Badge variant="secondary">shadow</Badge>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {route.cutoff ? (
          <div>
            <div>{route.cutoff.timeLabel}</div>
            <div className="text-xs text-muted-foreground">
              ships {route.cutoff.runDates.join(", ") || "—"}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">no cutoff configured</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {route.runs.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
          {route.runs.map((run: any) => (
            <button key={run.id} onClick={() => onOpenRun(run.id)} className="text-xs underline-offset-2 hover:underline">
              <span className="mr-1">{run.runDate}</span>
              <StatusBadge status={run.status} />
              {run.stopsHeld > 0 && <span className="ml-1 text-amber-600">{run.stopsHeld} held</span>}
            </button>
          ))}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || build.isPending}
          onClick={async () => {
            const res: any = await build.mutateAsync({ routeId: route.routeId });
            if (res?.ok) toast.success(`Built ${res.runIds.length} run(s) for ${route.code}`);
            else toast.error(res?.error ?? "Build failed");
          }}
        >
          {build.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Hammer className="w-4 h-4" />}
          <span className="ml-2">Build now</span>
        </Button>
      </TableCell>
    </TableRow>
  );
}

/* ---------------------------------------------------------- run detail */

function RunDetailDialog({ runId, onClose, canWrite }: { runId: string | null; onClose: () => void; canWrite: boolean }) {
  const q = useDispatchRun(runId);
  const push = useApproveAndPush();
  const preview = usePreviewDelta();
  const cancel = useCancelRun();
  const [showLoadSheet, setShowLoadSheet] = useState(false);

  const stops = (q.data?.stops ?? []) as any[];
  const loadSheet = useMemo(
    () =>
      buildLoadSheet(
        stops.map((s) => ({
          position: s.position,
          hold: s.hold,
          estPallets: s.est_pallets,
          estCubeFt: s.est_cube_ft,
          estWeightLbs: s.est_weight_lbs,
          customerName: s.customer_name,
          state: s.state,
          orderNo: s.order_no,
          pickTicketNo: s.pick_ticket_no,
        })),
      ),
    [stops],
  );

  return (
    <Dialog open={Boolean(runId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {q.data ? `${q.data.route?.code ?? "Route"} — ${q.data.run.run_date}` : "Dispatch run"}
          </DialogTitle>
        </DialogHeader>

        {q.isLoading && <div className="text-sm text-muted-foreground">Loading run…</div>}

        {q.data && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={q.data.run.status} />
              {!q.data.enabled && <Badge variant="secondary">shadow mode</Badge>}
              {q.data.locked && <Badge variant="secondary" className="bg-amber-500/15 text-amber-600">locked</Badge>}
              <span className="text-muted-foreground">lock {timeLocal(q.data.run.lock_at)}</span>
              <span className="text-muted-foreground">· pushed {timeLocal(q.data.run.pushed_at)}</span>
            </div>

            <div className="grid gap-3 sm:grid-cols-4 text-sm">
              <Card className="p-3"><div className="text-muted-foreground text-xs">Stops</div><div className="font-semibold">{num(q.data.run.stops_total)}</div></Card>
              <Card className="p-3"><div className="text-muted-foreground text-xs">Held</div><div className="font-semibold">{num(q.data.run.stops_held)}</div></Card>
              <Card className="p-3"><div className="text-muted-foreground text-xs">Pallets</div><div className="font-semibold">{num(q.data.run.est_pallets)}</div></Card>
              <Card className="p-3"><div className="text-muted-foreground text-xs">Weight (lbs)</div><div className="font-semibold">{num(q.data.run.est_weight_lbs)}</div></Card>
            </div>

            {q.data.run.error && (
              <Card className="p-3 border-destructive/40 bg-destructive/5 text-sm text-destructive">{q.data.run.error}</Card>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!canWrite || push.isPending || q.data.locked}
                onClick={async () => {
                  const res: any = await push.mutateAsync({ runId: q.data!.run.id });
                  if (res?.ok) toast.success(`Samsara ${res.action}`);
                  else toast.error(res?.error ?? "Push failed");
                }}
              >
                {push.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                <span className="ml-2">Approve &amp; push</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={preview.isPending}
                onClick={async () => {
                  const res: any = await preview.mutateAsync({ runId: q.data!.run.id });
                  if (!res?.ok) toast.error(res?.error ?? "Preview failed");
                }}
              >
                {preview.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                <span className="ml-2">Preview delta</span>
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowLoadSheet((v) => !v)}>
                <Printer className="w-4 h-4" />
                <span className="ml-2">{showLoadSheet ? "Delivery order" : "Load sheet (reverse)"}</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={!canWrite || cancel.isPending}
                onClick={async () => {
                  const res: any = await cancel.mutateAsync({ runId: q.data!.run.id });
                  if (res?.ok) toast.success(res.deletedInSamsara ? "Cancelled and removed from Samsara" : "Cancelled (Samsara untouched)");
                  else toast.error(res?.error ?? "Cancel failed");
                }}
              >
                <X className="w-4 h-4" />
                <span className="ml-2">Cancel run</span>
              </Button>
            </div>

            {preview.data && (preview.data as any).ok && (
              <Card className="p-3 text-sm">
                <div className="font-medium mb-1">
                  Samsara delta: {(preview.data as any).action} <span className="text-muted-foreground">({(preview.data as any).reason})</span>
                </div>
                {(preview.data as any).changes.length === 0 ? (
                  <div className="text-muted-foreground">No changes.</div>
                ) : (
                  <ul className="space-y-1">
                    {(preview.data as any).changes.map((c: any, i: number) => (
                      <li key={i} className="flex gap-2">
                        <Badge variant="secondary" className="shrink-0">{c.kind}</Badge>
                        <span className="font-medium">{c.label}</span>
                        <span className="text-muted-foreground">{c.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            <Card className="overflow-hidden">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-14">{showLoadSheet ? "Load" : "#"}</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="w-16">ST</TableHead>
                    <TableHead className="w-28">Order</TableHead>
                    {!showLoadSheet && <TableHead className="w-32">Arrival (CT)</TableHead>}
                    <TableHead className="w-20 text-right">Pallets</TableHead>
                    {!showLoadSheet && <TableHead className="w-40">Status</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {showLoadSheet
                    ? loadSheet.stops.map((s: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell>{s.loadOrder}</TableCell>
                          <TableCell className="truncate">{s.customerName ?? "—"}</TableCell>
                          <TableCell>{s.state ?? "—"}</TableCell>
                          <TableCell className="truncate">{s.orderNo ?? "—"}</TableCell>
                          <TableCell className="text-right">{num(s.estPallets)}</TableCell>
                        </TableRow>
                      ))
                    : stops.map((s) => (
                        <TableRow key={s.id} className={s.hold ? "bg-amber-500/5" : undefined}>
                          <TableCell>{s.position}</TableCell>
                          <TableCell className="truncate">{s.customer_name ?? "—"}</TableCell>
                          <TableCell>{s.state ?? "—"}</TableCell>
                          <TableCell className="truncate">{s.order_no ?? "—"}</TableCell>
                          <TableCell>{timeLocal(s.scheduled_arrival)}</TableCell>
                          <TableCell className="text-right">{num(s.est_pallets)}</TableCell>
                          <TableCell className="text-xs">
                            {s.hold ? (
                              <span className="text-amber-600 inline-flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> {s.hold_reason ?? "held"}
                              </span>
                            ) : (
                              <span className="text-muted-foreground inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> ok
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
            </Card>
            {showLoadSheet && (
              <p className="text-xs text-muted-foreground">
                Load sheet is delivery order reversed — last stop loads first. Held stops are excluded.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------- address queue */

function AddressQueueTab({ canWrite }: { canWrite: boolean }) {
  const q = useAddressQueue();
  const suggest = useSuggestAddressMatches();
  const resolve = useResolveAddress();
  const [active, setActive] = useState<any | null>(null);
  const [manualId, setManualId] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");

  const rows = q.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm text-muted-foreground">
        Every stop that could not be resolved to a verified Samsara address is held out of the pushed route. Nothing here is
        auto-accepted — confirm, correct, or create.
      </Card>

      <Card className="overflow-hidden">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Ship-to</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Raw address</TableHead>
              <TableHead className="w-32">Proposal</TableHead>
              <TableHead className="w-28 text-right">Review</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-sm text-muted-foreground">Queue is empty.</TableCell></TableRow>
            )}
            {rows.map((r: any, i: number) => (
              <TableRow key={r.id ?? `hold-${i}`}>
                <TableCell className="truncate">{r.p21_ship_to_id}</TableCell>
                <TableCell className="truncate">{r.customer_name ?? "—"}</TableCell>
                <TableCell className="truncate text-xs">
                  {[r.raw_addr1, r.raw_city, r.raw_state, r.raw_zip].filter(Boolean).join(", ") || r.hold_reason || "—"}
                </TableCell>
                <TableCell className="text-xs">
                  {r.samsara_address_id ? (
                    <span>
                      {r.match_method ?? "match"}{" "}
                      {r.match_confidence != null && <span className="text-muted-foreground">{Math.round(Number(r.match_confidence) * 100)}%</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setActive(r);
                      setManualId(r.samsara_address_id ?? "");
                      setLat("");
                      setLng("");
                      suggest.mutate({ addr1: r.raw_addr1, addr2: r.raw_addr2, city: r.raw_city, state: r.raw_state, zip: r.raw_zip });
                    }}
                  >
                    <MapPin className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={Boolean(active)} onOpenChange={(o) => !o && setActive(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Resolve ship-to {active?.p21_ship_to_id}</DialogTitle></DialogHeader>
          {active && (
            <div className="space-y-4 text-sm">
              <div className="text-muted-foreground">
                {[active.raw_addr1, active.raw_addr2, active.raw_city, active.raw_state, active.raw_zip].filter(Boolean).join(", ") || "No raw address captured"}
              </div>

              <div>
                <Label className="text-xs">Suggested Samsara addresses</Label>
                {suggest.isPending && <div className="text-muted-foreground text-xs mt-1">Scoring candidates…</div>}
                {suggest.data && !(suggest.data as any).ok && (
                  <div className="text-destructive text-xs mt-1">{(suggest.data as any).error}</div>
                )}
                <div className="mt-2 space-y-1">
                  {((suggest.data as any)?.candidates ?? []).map((c: any) => (
                    <button
                      key={c.samsaraAddressId}
                      onClick={() => setManualId(c.samsaraAddressId)}
                      className={`w-full text-left rounded-md border px-3 py-2 text-xs ${manualId === c.samsaraAddressId ? "border-primary bg-primary/5" : "border-border"}`}
                    >
                      <div className="font-medium">{c.name ?? c.formattedAddress}</div>
                      <div className="text-muted-foreground">{c.formattedAddress} · {Math.round(c.score * 100)}% {c.method}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="sm:col-span-3">
                  <Label className="text-xs">Samsara address id</Label>
                  <Input value={manualId} onChange={(e) => setManualId(e.target.value)} placeholder="paste or pick above" />
                </div>
                <div>
                  <Label className="text-xs">Latitude (create only)</Label>
                  <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="33.5207" />
                </div>
                <div>
                  <Label className="text-xs">Longitude (create only)</Label>
                  <Input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-86.8025" />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!canWrite || !manualId || resolve.isPending}
                  onClick={async () => {
                    const res: any = await resolve.mutateAsync({
                      action: active.samsara_address_id === manualId ? "confirm" : "correct",
                      p21ShipToId: active.p21_ship_to_id,
                      samsaraAddressId: manualId,
                      customerId: active.customer_id,
                      customerName: active.customer_name,
                      raw: { addr1: active.raw_addr1, addr2: active.raw_addr2, city: active.raw_city, state: active.raw_state, zip: active.raw_zip },
                    });
                    if (res?.ok) { toast.success("Address verified"); setActive(null); }
                    else toast.error(res?.error ?? "Failed");
                  }}
                >
                  {resolve.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  <span className="ml-2">Verify mapping</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite || resolve.isPending || !lat || !lng}
                  onClick={async () => {
                    const res: any = await resolve.mutateAsync({
                      action: "create",
                      p21ShipToId: active.p21_ship_to_id,
                      customerId: active.customer_id,
                      customerName: active.customer_name,
                      raw: { addr1: active.raw_addr1, addr2: active.raw_addr2, city: active.raw_city, state: active.raw_state, zip: active.raw_zip },
                      latitude: Number(lat),
                      longitude: Number(lng),
                    });
                    if (res?.ok) { toast.success("Samsara address created and mapped"); setActive(null); }
                    else toast.error(res?.error ?? "Failed");
                  }}
                >
                  <MapPin className="w-4 h-4" />
                  <span className="ml-2">Create in Samsara</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                No geocoder is configured, so creating an address requires explicit coordinates.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------- sequence editor */

function SequenceTab({ routes, canWrite }: { routes: any[]; canWrite: boolean }) {
  const [routeId, setRouteId] = useState<string | null>(routes[0]?.routeId ?? null);
  const q = useSequenceTemplate(routeId);
  const imp = useImportSequencePaste();
  const [text, setText] = useState("");

  const preview = imp.data as any;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4 space-y-3">
        <div>
          <Label className="text-xs">Route</Label>
          <Select value={routeId ?? undefined} onValueChange={(v) => setRouteId(v)}>
            <SelectTrigger><SelectValue placeholder="Pick a route" /></SelectTrigger>
            <SelectContent>
              {routes.map((r) => <SelectItem key={r.routeId} value={r.routeId}>{r.code} — {r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Card className="overflow-hidden">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>City</TableHead>
                <TableHead className="w-14">ST</TableHead>
                <TableHead className="w-32">Day label</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(q.data?.rows ?? []).length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-sm text-muted-foreground">No template rows.</TableCell></TableRow>
              )}
              {(q.data?.rows ?? []).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>{r.position}</TableCell>
                  <TableCell className="truncate">{r.city_norm}{r.is_pickup && <Badge variant="secondary" className="ml-2">pickup</Badge>}</TableCell>
                  <TableCell>{r.state ?? "—"}</TableCell>
                  <TableCell className="truncate">{r.delivery_dow_label ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </Card>

      <Card className="p-4 space-y-3">
        <div>
          <Label className="text-xs">Paste template — one stop per line: City, ST, DAY LABEL[, PICKUP]</Label>
          <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Birmingham, AL, MON\nBourg, LA, WED (Thur)"} />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!routeId || imp.isPending}
            onClick={() => imp.mutate({ routeId: routeId!, text })}
          >
            Preview
          </Button>
          <Button
            size="sm"
            disabled={!canWrite || !routeId || imp.isPending || !preview?.rows?.length || preview?.errors?.length}
            onClick={async () => {
              const res: any = await imp.mutateAsync({ routeId: routeId!, text, commit: true });
              if (res?.ok && res.committed) toast.success(`Replaced template with ${res.rows.length} stop(s)`);
              else toast.error(res?.error ?? "Import failed");
            }}
          >
            Replace template
          </Button>
        </div>
        {preview && (
          <div className="text-sm space-y-2">
            <div>{preview.rows.length} valid line(s), {preview.errors.length} rejected.</div>
            {preview.errors.length > 0 && (
              <ul className="text-xs text-destructive space-y-1">
                {preview.errors.map((e: any) => <li key={e.lineNo}>line {e.lineNo}: {e.reason} — “{e.raw}”</li>)}
              </ul>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Day labels are stored verbatim; only the first day listed decides which run day a stop lands on.
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- settings */

function SettingsCard({ routes, isAdmin }: { routes: any[]; isAdmin: boolean }) {
  const q = useDispatchSettings();
  const save = useSaveDispatchSettings();
  const s = q.data as any;

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

  return (
    <Card className="p-4 space-y-4">
      <div>
        <h3 className="font-semibold">Dispatch settings</h3>
        <p className="text-sm text-muted-foreground">
          Shadow mode is the default. A route must be enabled before any run can be pushed, and auto-push additionally lets cron
          push it without a human click.
        </p>
      </div>

      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <Label className="text-xs">Depot depart (local)</Label>
              <Input defaultValue={s.depotDepartLocal} disabled={!isAdmin}
                onBlur={(e) => save.mutate({ depotDepartLocal: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Stop increment (min)</Label>
              <Input type="number" defaultValue={s.stopIncrementMin} disabled={!isAdmin}
                onBlur={(e) => save.mutate({ stopIncrementMin: Number(e.target.value) })} />
            </div>
            <div>
              <Label className="text-xs">Lock offset before depart</Label>
              <Input defaultValue={s.lockOffset} disabled={!isAdmin}
                onBlur={(e) => save.mutate({ lockOffset: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">Build delay after cutoff (min)</Label>
              <Input type="number" defaultValue={s.buildDelayMin} disabled={!isAdmin}
                onBlur={(e) => save.mutate({ buildDelayMin: Number(e.target.value) })} />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs">Source view</Label>
              <Input defaultValue={s.viewName} disabled={!isAdmin}
                onBlur={(e) => save.mutate({ viewName: e.target.value })} />
            </div>
            <div className="flex items-end gap-2">
              <Switch checked={s.viewAvailable} disabled={!isAdmin} onCheckedChange={(v) => save.mutate({ viewAvailable: v })} />
              <span className="text-sm">Source view available</span>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead className="w-32">Enabled</TableHead>
                  <TableHead className="w-32">Auto-push</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((r) => (
                  <TableRow key={r.routeId}>
                    <TableCell>{r.code} <span className="text-muted-foreground text-xs">{r.hub}</span></TableCell>
                    <TableCell>
                      <Switch
                        checked={(s.enabledRouteIds ?? []).includes(r.routeId)}
                        disabled={!isAdmin}
                        onCheckedChange={(v) => save.mutate({ enabledRouteIds: toggle(s.enabledRouteIds ?? [], r.routeId, v) })}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={(s.autoPushRouteIds ?? []).includes(r.routeId)}
                        disabled={!isAdmin || !(s.enabledRouteIds ?? []).includes(r.routeId)}
                        onCheckedChange={(v) => save.mutate({ autoPushRouteIds: toggle(s.autoPushRouteIds ?? [], r.routeId, v) })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!isAdmin && <p className="text-xs text-muted-foreground">Settings are admin-only; you have read access.</p>}
        </>
      )}
    </Card>
  );
}

function DriverMappingCard({ routes, canWrite }: { routes: any[]; canWrite: boolean }) {
  const q = useDriverMappings();
  const save = useSaveDriverMapping();
  const byRoute = new Map<string, any>((q.data?.rows ?? []).map((r: any) => [r.route_id, r]));

  return (
    <Card className="p-4 space-y-3">
      <div>
        <h3 className="font-semibold">Driver assignment</h3>
        <p className="text-sm text-muted-foreground">
          Unconfirmed mappings stay inert — routes are created unassigned rather than assigned to a guess.
        </p>
      </div>
      {q.data?.rosterError && <div className="text-xs text-destructive">Samsara roster unavailable: {q.data.rosterError}</div>}
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Route</TableHead>
              <TableHead>Samsara driver</TableHead>
              <TableHead className="w-28">Confirmed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routes.map((r) => {
              const m = byRoute.get(r.routeId);
              return (
                <TableRow key={r.routeId}>
                  <TableCell>{r.code}</TableCell>
                  <TableCell>
                    <Select
                      value={m?.samsara_driver_id ?? undefined}
                      onValueChange={(v) => save.mutate({ routeId: r.routeId, samsaraDriverId: v, driverNameRaw: (q.data?.roster ?? []).find((d) => d.id === v)?.name ?? null, confirmed: false })}
                    >
                      <SelectTrigger disabled={!canWrite}><SelectValue placeholder="unassigned" /></SelectTrigger>
                      <SelectContent>
                        {(q.data?.roster ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={Boolean(m?.confirmed)}
                      disabled={!canWrite || !m?.samsara_driver_id}
                      onCheckedChange={(v) => save.mutate({ routeId: r.routeId, samsaraDriverId: m?.samsara_driver_id ?? null, driverNameRaw: m?.driver_name_raw ?? null, confirmed: v })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
