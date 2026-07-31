import { useMemo, useState } from "react";
import { Bell, Check, TruckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useCapacityAlerts, useSetCapacityAlertStatus } from "@/hooks/useCapacityAlerts";
import { toast } from "sonner";

function pct(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(Number(v) * 100)}%`;
}

/**
 * In-app notification center for capacity alerts.
 * Reps only ever see alerts carrying their own rep code (enforced server-side);
 * managers see every alert with rep attribution.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useCapacityAlerts("all");
  const ack = useSetCapacityAlertStatus();

  const alerts = (data?.alerts ?? []) as any[];
  const unread = data?.unread ?? 0;
  const visible = useMemo(() => alerts.slice(0, 30), [alerts]);

  async function onAck(id: string, status: "acknowledged" | "resolved") {
    try {
      await ack.mutateAsync({ id, status });
      toast.success(status === "resolved" ? "Alert resolved" : "Alert acknowledged");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not update alert");
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="w-4 h-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold flex items-center justify-center">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        <div className="px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Capacity alerts</p>
            <p className="text-xs text-muted-foreground">
              {data?.isManager ? "All routes" : data?.repCode ? `Your routes (${data.repCode})` : "No rep code assigned"}
            </p>
          </div>
          {unread > 0 && <Badge variant="destructive">{unread} new</Badge>}
        </div>
        <Separator />
        <ScrollArea className="max-h-[420px]">
          {isLoading && <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && visible.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">No capacity alerts. Trucks are running above threshold.</p>
          )}
          {visible.map((a) => (
            <div key={a.id} className="px-4 py-3 border-b last:border-b-0">
              <div className="flex items-start gap-2">
                <TruckIcon className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{a.route_code}</span>
                    {a.status === "new" && <Badge variant="destructive" className="text-[10px]">New</Badge>}
                    {a.status === "acknowledged" && <Badge variant="secondary" className="text-[10px]">Acknowledged</Badge>}
                    {a.status === "resolved" && <Badge variant="outline" className="text-[10px]">Resolved</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pct(a.avg_utilization_in_streak)} avg over {a.streak_days} consecutive days
                    {a.streak_from ? ` (${a.streak_from} → ${a.streak_to})` : ""}, below {Number(a.threshold_pct)}%.
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Month {pct(a.avg_month)} · Quarter {pct(a.avg_quarter)} · 12 mo {pct(a.avg_year)}
                  </p>
                  {data?.isManager && (
                    <p className="text-xs mt-1">
                      {(a.rep_codes ?? []).length ? (a.rep_codes as string[]).join(", ") : <span className="italic text-muted-foreground">unassigned route</span>}
                      {(a.delivery?.muted_reps ?? []).length > 0 && (
                        <Badge variant="outline" className="ml-2 text-[10px]">muted: {(a.delivery.muted_reps as string[]).join(", ")}</Badge>
                      )}
                      {(a.delivery?.capped_reps ?? []).length > 0 && (
                        <Badge variant="outline" className="ml-2 text-[10px]">weekly cap: {(a.delivery.capped_reps as string[]).join(", ")}</Badge>
                      )}
                    </p>
                  )}
                  {a.status !== "resolved" && (
                    <div className="flex gap-2 mt-2">
                      {a.status === "new" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onAck(a.id, "acknowledged")}>
                          <Check className="w-3 h-3 mr-1" />Acknowledge
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onAck(a.id, "resolved")}>
                        Resolve
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
