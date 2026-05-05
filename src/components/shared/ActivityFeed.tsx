import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { formatDistanceToNow } from "date-fns";
import { FileInput, Receipt, Truck, AlertTriangle, FileBarChart, BadgeDollarSign, Activity } from "lucide-react";

const ICONS: Record<string, any> = {
  "order.received": FileInput, "order.submitted": FileInput, "order.acknowledged": FileInput,
  "ar.reminder_sent": Receipt, "fleet.synced": Truck, "damage.logged": AlertTriangle,
  "report.generated": FileBarChart, "spiff.calculated": BadgeDollarSign,
};

export function ActivityFeed() {
  const [events, setEvents] = useState<any[]>([]);

  useEffect(() => {
    supabase.from("activity_events").select("*").order("created_at", { ascending: false }).limit(20)
      .then(({ data }) => setEvents(data ?? []));

    const ch = supabase.channel("activity-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_events" }, (p) => {
        setEvents((prev) => [p.new as any, ...prev].slice(0, 20));
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2"><Activity className="w-4 h-4 text-accent" /> Recent activity</h3>
        <span className="text-xs text-muted-foreground">Live</span>
      </div>
      <div className="divide-y">
        {events.length === 0 && <p className="text-sm text-muted-foreground py-4">No activity yet.</p>}
        {events.map((e) => {
          const Icon = ICONS[e.event_type] ?? Activity;
          return (
            <div key={e.id} className="flex items-start gap-3 py-3">
              <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm">{e.message}</p>
                <p className="text-xs text-muted-foreground">
                  {e.actor_name ?? "system"} · {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
