import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MapPin } from "lucide-react";
import { useUpdateDriverTimeEvent } from "@/hooks/useDriverTime";
import { formatMinutes, hubTimezone } from "@/lib/driver-time/reconciliation";

export const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function hm(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function clock(iso: string, hub?: string | null) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: hubTimezone(hub) });
}

export function dayLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

export const STATUS_STYLE: Record<string, string> = {
  new: "bg-destructive/10 text-destructive border-destructive/30",
  reviewed: "bg-primary/10 text-primary border-primary/30",
  excused: "bg-muted text-muted-foreground",
};

export function thresholdLabel(minutes: number): string {
  return `${Number((minutes / 60).toFixed(2))} h`;
}

export function DriverCard({ driver, isAdmin, thresholdMinutes }: { driver: any; weekStart: string; isAdmin: boolean; thresholdMinutes: number }) {
  const update = useUpdateDriverTimeEvent();

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
            {hm(driver.flaggedMinutes)} reported · {driver.official ? "Official weekday report" : "Automated estimate"} · automated weekdays {hm(driver.automatedMinutes)}
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
          <span className="text-sm font-bold" data-testid="warehouse-over-threshold">
            Warehouse time over {thresholdLabel(thresholdMinutes)}: {formatMinutes(driver.flaggedMinutes)}
          </span>
        </div>
      </div>

      {isAdmin && driver.official && <div className="mb-3 rounded border bg-muted/30 p-3 text-sm space-y-2">
        <div><strong>Official {formatMinutes(driver.officialMinutes)}</strong> · automated {formatMinutes(driver.automatedMinutes)} · variance {formatMinutes(driver.varianceMinutes)} (automated minus official)</div>
        <p className="text-xs text-muted-foreground">{driver.official.source} · {driver.official.reason}</p>
        {!!driver.official.intervals?.length && <details><summary className="cursor-pointer">Official time blocks ({driver.official.intervals.length})</summary>
          {driver.official.intervals.map((i:any,n:number)=><p key={n} className="text-xs mt-1 flex items-center gap-1">
            <span>{dayLabel(i.date)} · {clock(i.start,driver.hub)} – {clock(i.end,driver.hub)} · {hm(i.minutes)} {i.note ? `· ${i.note}` : ""}</span>
            {i.verified === false && <Badge variant="outline" className="text-[10px]">No Samsara evidence</Badge>}
          </p>)}
        </details>}
        <details><summary className="cursor-pointer">Correction history ({driver.history.length})</summary>
          {driver.history.map((h:any,n:number)=><p key={n} className="text-xs mt-1">{h.at} · {h.after ? formatMinutes(h.after.minutes) : "Cleared"} · {h.after?.reason ?? ""}</p>)}
        </details>
      </div>}
      {!!driver.events.length && <p className="mb-2 text-xs font-medium text-muted-foreground">Automated evidence ({driver.events.length} blocks)</p>}
      <div className="space-y-3">
        {byDay.map(([date, events]) => (
          <div key={date}>
            <div className="text-xs font-medium text-muted-foreground mb-1">{dayLabel(date)}</div>
            <div className="rounded-md border divide-y">
              {events.map((ev: any) => (
                <div key={ev.id} className="p-3 flex flex-wrap items-center gap-3 text-sm">
                  <div className="font-mono text-xs w-40">{clock(ev.start_ts,ev.hub)} – {clock(ev.end_ts,ev.hub)}</div>
                  <div className="font-medium w-24">{hm(ev.duration_min)}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-[200px]">
                    <MapPin className="w-3 h-3" />
                    {ev.address_name ?? "location unresolved"}
                    {ev.location_source !== "log" && ev.location_source !== "assumed_hub" && (
                      <Badge variant="outline" className="ml-1 text-[10px]">{ev.location_source}</Badge>
                    )}
                    {ev.location_source === "assumed_hub" && (
                      <Badge variant="outline" className="ml-1 text-[10px]">No truck / GPS — assumed at home hub</Badge>
                    )}

                  </div>
                  {ev.nelsonOnly && <Badge variant="outline" className="text-[10px]">Not in official report</Badge>}
                  {ev.superseded_at && <Badge variant="outline">superseded</Badge>}
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
