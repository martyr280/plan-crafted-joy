import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KpiCard } from "@/components/shared/KpiCard";
import { ActivityFeed } from "@/components/shared/ActivityFeed";
import { FileInput, Receipt, Truck, AlertTriangle, FileBarChart } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});

function HomePage() {
  const [kpi, setKpi] = useState<any>({});

  useEffect(() => {
    (async () => {
      const [pending, oldest, arToday, fleets, damage, weekOrders, lastWeekOrders] = await Promise.all([
        supabase.from("orders").select("*", { count: "exact", head: true }).eq("status", "pending_review"),
        supabase.from("orders").select("created_at").eq("status", "pending_review").order("created_at", { ascending: true }).limit(1),
        supabase.from("collection_emails").select("*", { count: "exact", head: true }).gte("sent_at", new Date(Date.now() - 86400000).toISOString()),
        supabase.from("fleet_loads").select("capacity_pct, status").in("status", ["loading", "departed"]),
        supabase.from("damage_reports").select("*", { count: "exact", head: true }).eq("status", "open"),
        supabase.from("orders").select("*", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString()),
        supabase.from("orders").select("*", { count: "exact", head: true })
          .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString())
          .lt("created_at", new Date(Date.now() - 7 * 86400000).toISOString()),
      ]);
      const oldestAge = oldest.data?.[0] ? formatDistanceToNow(new Date(oldest.data[0].created_at)) : "—";
      const fleetCount = fleets.data?.length ?? 0;
      const avgCap = fleetCount ? Math.round((fleets.data!.reduce((a, f) => a + (f.capacity_pct ?? 0), 0) / fleetCount)) : 0;
      const wow = lastWeekOrders.count ? ((weekOrders.count! - lastWeekOrders.count) / lastWeekOrders.count) * 100 : 0;
      setKpi({
        pending: pending.count ?? 0, oldestAge,
        arToday: arToday.count ?? 0,
        fleetCount, avgCap,
        damage: damage.count ?? 0,
        weekOrders: weekOrders.count ?? 0, wow,
      });
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Operations overview · live</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard label="Orders in Review" value={kpi.pending ?? 0} sub={`Oldest: ${kpi.oldestAge ?? "—"}`} icon={<FileInput className="w-5 h-5" />} />
        <KpiCard label="AR Reminders (24h)" value={kpi.arToday ?? 0} icon={<Receipt className="w-5 h-5" />} />
        <KpiCard label="Active Fleet Loads" value={kpi.fleetCount ?? 0} sub={`Avg capacity ${kpi.avgCap ?? 0}%`} icon={<Truck className="w-5 h-5" />} />
        <KpiCard label="Open Damage Claims" value={kpi.damage ?? 0} icon={<AlertTriangle className="w-5 h-5" />} />
        <KpiCard label="Orders this Week" value={kpi.weekOrders ?? 0} icon={<FileBarChart className="w-5 h-5" />} trend={kpi.wow ?? 0} />
      </div>

      <ActivityFeed />
    </div>
  );
}
