import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { SifXmlImporter } from "@/components/shared/SifXmlImporter";
import { Truck } from "lucide-react";

export const Route = createFileRoute("/_app/logistics")({ component: LogisticsPage });

function CapacityBar({ pct }: { pct: number }) {
  const cls = pct < 80 ? "bg-success" : pct < 95 ? "bg-warning" : "bg-destructive";
  return <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className={`h-full ${cls}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>;
}

function LogisticsPage() {
  const [loads, setLoads] = useState<any[]>([]);
  const [damage, setDamage] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);

  function load() {
    supabase.from("fleet_loads").select("*").order("departure_date").then(({ data }) => setLoads(data ?? []));
    supabase.from("damage_reports").select("*").order("created_at", { ascending: false }).then(({ data }) => setDamage(data ?? []));
  }
  useEffect(() => { load(); }, []);

  const active = loads.filter((l) => l.status === "loading" || l.status === "departed");

  return (
    <div>
      <ModuleHeader
        title="Logistics"
        description="Live fleet capacity, route manifests, and damage log."
        actions={<SifXmlImporter scope="loads" onImported={load} triggerLabel="Import Loads SIF/XML" />}
      />

      <Tabs defaultValue="loads">
        <TabsList><TabsTrigger value="loads">Active Loads</TabsTrigger><TabsTrigger value="damage">Damage Log</TabsTrigger><TabsTrigger value="photos">Samsara Photos</TabsTrigger></TabsList>

        <TabsContent value="loads">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {active.map((l) => (
              <Card key={l.id} className="p-4 cursor-pointer hover:border-accent transition" onClick={() => setSelected(l)}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2"><Truck className="w-5 h-5 text-primary" /><span className="font-semibold">{l.route_code}</span></div>
                  <Badge variant="outline">{l.status}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{l.driver_name} · {l.truck_id}</p>
                <p className="text-xs text-muted-foreground mb-3">Departs {l.departure_date}</p>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs"><span>Capacity</span><span>{l.capacity_pct}%</span></div>
                  <CapacityBar pct={Number(l.capacity_pct ?? 0)} />
                </div>
                <p className="text-xs text-muted-foreground mt-2">{(l.orders as any[])?.length ?? 0} orders · {l.total_weight}lbs · {l.total_cubic_ft}ft³</p>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="damage">
          <Card><Table><TableHeader><TableRow><TableHead>P21 Order</TableHead><TableHead>Stage</TableHead><TableHead>Severity</TableHead><TableHead>Driver</TableHead><TableHead>Route</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>{damage.map((d) => <TableRow key={d.id}><TableCell>{d.p21_order_id}</TableCell><TableCell>{d.stage}</TableCell><TableCell><Badge variant={d.severity === "severe" ? "destructive" : "secondary"}>{d.severity}</Badge></TableCell><TableCell>{d.driver_name ?? "—"}</TableCell><TableCell>{d.route_code}</TableCell><TableCell>{d.status}</TableCell></TableRow>)}</TableBody>
          </Table></Card>
        </TabsContent>

        <TabsContent value="photos">
          <Card className="p-6 text-center text-muted-foreground">
            <p>Samsara photo viewer — connect Samsara API to fetch delivery proof photos by pick ticket.</p>
          </Card>
        </TabsContent>
      </Tabs>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg">
          {selected && <>
            <SheetHeader><SheetTitle>{selected.route_code} · {selected.driver_name}</SheetTitle></SheetHeader>
            <p className="text-sm text-muted-foreground mt-2">Truck {selected.truck_id} · departs {selected.departure_date}</p>
            <div className="mt-4 space-y-2">
              {(selected.orders as any[]).map((o, i) => (
                <Card key={i} className="p-3"><p className="font-medium text-sm">{o.p21_order_id}</p><p className="text-xs text-muted-foreground">{o.customer_name} · {o.weight}lbs · {o.cubic_ft}ft³</p></Card>
              ))}
            </div>
          </>}
        </SheetContent>
      </Sheet>
    </div>
  );
}
