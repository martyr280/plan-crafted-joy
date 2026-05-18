import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { SifXmlImporter } from "@/components/shared/SifXmlImporter";
import { Truck, MapPin, RefreshCw } from "lucide-react";
import { getFleetLocations, listTrips } from "@/lib/samsara.functions";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_app/logistics")({ component: LogisticsPage });

function CapacityBar({ pct }: { pct: number }) {
  const cls = pct < 80 ? "bg-success" : pct < 95 ? "bg-warning" : "bg-destructive";
  return <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className={`h-full ${cls}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>;
}

// Page through all rows — PostgREST caps responses at 1000.
async function fetchAll(table: string) {
  const out: any[] = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await supabase.from(table as any).select("*").range(from, from + step - 1);
    if (error) break;
    out.push(...(data ?? []));
    if (!data || data.length < step) break;
  }
  return out;
}

function LogisticsPage() {
  const [loads, setLoads] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [damage, setDamage] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [loadStatus, setLoadStatus] = useState<string>("all");
  const [routeSearch, setRouteSearch] = useState("");
  const [routeHub, setRouteHub] = useState<string>("all");
  const [routeDay, setRouteDay] = useState<string>("all");

  function load() {
    fetchAll("fleet_loads").then((d) => setLoads(d.sort((a, b) => String(a.departure_date ?? "").localeCompare(String(b.departure_date ?? "")))));
    fetchAll("fleet_routes").then(setRoutes);
    fetchAll("damage_reports").then((d) => setDamage(d.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))));
  }
  useEffect(() => { load(); }, []);

  const visibleLoads = useMemo(
    () => loadStatus === "all" ? loads : loads.filter((l) => l.status === loadStatus),
    [loads, loadStatus]
  );

  const hubs = useMemo(() => Array.from(new Set(routes.map((r) => r.hub).filter(Boolean))).sort(), [routes]);
  const days = useMemo(() => Array.from(new Set(routes.map((r) => r.delivery_day).filter(Boolean))).sort(), [routes]);

  const visibleRoutes = useMemo(() => {
    const q = routeSearch.trim().toLowerCase();
    return routes.filter((r) => {
      if (routeHub !== "all" && r.hub !== routeHub) return false;
      if (routeDay !== "all" && r.delivery_day !== routeDay) return false;
      if (q && !`${r.route_code} ${r.destination_city} ${r.driver_name} ${r.group_label}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [routes, routeSearch, routeHub, routeDay]);

  const groupedRoutes = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of visibleRoutes) {
      const key = r.group_label || r.route_code || "Unassigned";
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleRoutes]);

  return (
    <div>
      <ModuleHeader
        title="Logistics"
        description="Live fleet capacity, route manifests, and damage log."
        actions={<SifXmlImporter scope="loads" onImported={load} triggerLabel="Import Loads SIF/XML" />}
      />

      <Tabs defaultValue="loads">
        <TabsList>
          <TabsTrigger value="loads">Loads ({loads.length})</TabsTrigger>
          <TabsTrigger value="routes">Routes ({routes.length})</TabsTrigger>
          <TabsTrigger value="damage">Damage Log ({damage.length})</TabsTrigger>
          <TabsTrigger value="samsara">Live Fleet (Samsara)</TabsTrigger>
        </TabsList>

        <TabsContent value="loads">
          <div className="flex items-center gap-2 mb-3">
            <Select value={loadStatus} onValueChange={setLoadStatus}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="loading">Loading</SelectItem>
                <SelectItem value="departed">Departed</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">{visibleLoads.length} of {loads.length} loads</span>
          </div>

          {visibleLoads.length === 0 ? (
            <Card className="p-6 text-center text-muted-foreground">No loads match the current filter.</Card>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleLoads.map((l) => (
                <Card key={l.id} className="p-4 cursor-pointer hover:border-accent transition" onClick={() => setSelected(l)}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2"><Truck className="w-5 h-5 text-primary" /><span className="font-semibold">{l.route_code}</span></div>
                    <Badge variant="outline">{l.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{l.driver_name ?? "—"}{l.truck_id ? ` · ${l.truck_id}` : ""}</p>
                  <p className="text-xs text-muted-foreground mb-3">Departs {l.departure_date ?? "—"}</p>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs"><span>Capacity</span><span>{l.capacity_pct}%</span></div>
                    <CapacityBar pct={Number(l.capacity_pct ?? 0)} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">{(l.orders as any[])?.length ?? 0} orders · {l.total_weight ?? 0}lbs · {l.total_cubic_ft ?? 0}ft³</p>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="routes">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Input placeholder="Search route, city, driver…" value={routeSearch} onChange={(e) => setRouteSearch(e.target.value)} className="max-w-xs" />
            <Select value={routeHub} onValueChange={setRouteHub}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Hub" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All hubs</SelectItem>
                {hubs.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={routeDay} onValueChange={setRouteDay}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Day" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All days</SelectItem>
                {days.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">{visibleRoutes.length} of {routes.length} stops</span>
            {(routeSearch || routeHub !== "all" || routeDay !== "all") && (
              <Button variant="ghost" size="sm" onClick={() => { setRouteSearch(""); setRouteHub("all"); setRouteDay("all"); }}>Clear</Button>
            )}
          </div>

          {groupedRoutes.length === 0 ? (
            <Card className="p-6 text-center text-muted-foreground">No routes match the current filter.</Card>
          ) : (
            <div className="space-y-4">
              {groupedRoutes.map(([label, rows]) => (
                <Card key={label} className="overflow-hidden">
                  <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
                    <div className="flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /><span className="font-semibold text-sm">{label}</span></div>
                    <span className="text-xs text-muted-foreground">{rows.length} stop{rows.length === 1 ? "" : "s"}</span>
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Hub</TableHead>
                        <TableHead>Route</TableHead>
                        <TableHead>Destination</TableHead>
                        <TableHead>Day</TableHead>
                        <TableHead>Driver</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.hub}</TableCell>
                          <TableCell><Badge variant="outline">{r.route_code ?? "—"}</Badge></TableCell>
                          <TableCell>{r.destination_city}</TableCell>
                          <TableCell>{r.delivery_day ?? "—"}</TableCell>
                          <TableCell>{r.driver_name ?? "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.schedule_notes ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="damage">
          {damage.length === 0 ? (
            <Card className="p-6 text-center text-muted-foreground">No damage reports recorded.</Card>
          ) : (
            <Card><Table><TableHeader><TableRow><TableHead>P21 Order</TableHead><TableHead>Stage</TableHead><TableHead>Severity</TableHead><TableHead>Driver</TableHead><TableHead>Route</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{damage.map((d) => <TableRow key={d.id}><TableCell>{d.p21_order_id}</TableCell><TableCell>{d.stage}</TableCell><TableCell><Badge variant={d.severity === "severe" ? "destructive" : "secondary"}>{d.severity}</Badge></TableCell><TableCell>{d.driver_name ?? "—"}</TableCell><TableCell>{d.route_code}</TableCell><TableCell>{d.status}</TableCell></TableRow>)}</TableBody>
            </Table></Card>
          )}
        </TabsContent>

        <TabsContent value="samsara">
          <SamsaraLivePanel />
        </TabsContent>
      </Tabs>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg">
          {selected && <>
            <SheetHeader><SheetTitle>{selected.route_code} · {selected.driver_name}</SheetTitle></SheetHeader>
            <p className="text-sm text-muted-foreground mt-2">Truck {selected.truck_id || "—"} · departs {selected.departure_date}</p>
            <div className="mt-4 space-y-2">
              {(selected.orders as any[])?.map((o, i) => (
                <Card key={i} className="p-3"><p className="font-medium text-sm">{o.p21_order_id}</p><p className="text-xs text-muted-foreground">{o.customer_name} · {o.weight}lbs · {o.cubic_ft}ft³</p></Card>
              ))}
            </div>
          </>}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SamsaraLivePanel() {
  const getLocs = useServerFn(getFleetLocations);
  const getTrips = useServerFn(listTrips);

  const locs = useQuery({
    queryKey: ["samsara", "locations"],
    queryFn: () => getLocs(),
    refetchInterval: 60_000,
  });
  const trips = useQuery({
    queryKey: ["samsara", "trips", 24],
    queryFn: () => getTrips({ data: { hours: 24 } }),
  });

  const vehicles = locs.data?.vehicles ?? [];
  const tripRows = trips.data?.trips ?? [];
  const err = locs.data?.error ?? trips.data?.error;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Live vehicle positions</p>
          <p className="text-xs text-muted-foreground">Polled from Samsara every 60s.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { locs.refetch(); trips.refetch(); }}>
          <RefreshCw className="w-3 h-3 mr-1" /> Refresh
        </Button>
      </div>

      {err && (
        <Card className="p-4 border-destructive/40 bg-destructive/5 text-sm text-destructive">{err}</Card>
      )}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vehicle</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Speed</TableHead>
              <TableHead>Last update</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locs.isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>
            ) : vehicles.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-6">No vehicles reporting.</TableCell></TableRow>
            ) : vehicles.map((v: any) => (
              <TableRow key={v.id}>
                <TableCell className="font-medium">{v.name}</TableCell>
                <TableCell className="text-sm">
                  {v.reverseGeo ?? (v.latitude != null ? `${v.latitude.toFixed(4)}, ${v.longitude.toFixed(4)}` : "—")}
                </TableCell>
                <TableCell>{v.speedMph != null ? `${Math.round(v.speedMph)} mph` : "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {v.time ? formatDistanceToNow(new Date(v.time), { addSuffix: true }) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <div>
        <p className="text-sm font-semibold mb-2">Trips (last 24h)</p>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vehicle</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Distance</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trips.isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>
              ) : tripRows.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">No trips in window.</TableCell></TableRow>
              ) : tripRows.slice(0, 50).map((t: any) => (
                <TableRow key={t.id}>
                  <TableCell>{t.vehicle?.name ?? t.vehicle?.id ?? "—"}</TableCell>
                  <TableCell className="text-xs">{t.startLocation?.formattedLocation ?? "—"}</TableCell>
                  <TableCell className="text-xs">{t.endLocation?.formattedLocation ?? "—"}</TableCell>
                  <TableCell>{t.distanceMeters != null ? `${(t.distanceMeters / 1609.34).toFixed(1)} mi` : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.startTime ? formatDistanceToNow(new Date(t.startTime), { addSuffix: true }) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
