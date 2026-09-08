import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDriverTimeConfig, useSaveWarehouseActual } from "@/hooks/useDriverTime";
import { driverNameKey, formatMinutes, parseHoursMinutes } from "@/lib/driver-time/reconciliation";
import { toast } from "sonner";

export function WarehouseActualEditor({weekStart,drivers}:{weekStart:string;drivers:any[]}) {
  const config = useDriverTimeConfig();
  const save = useSaveWarehouseActual();
  const [driverId,setDriverId] = useState("");
  const [hub,setHub] = useState("Birmingham");
  const [hours,setHours] = useState("");
  const [source,setSource] = useState("");
  const [reason,setReason] = useState("");
  const roster = config.data?.drivers ?? [];
  const selected = roster.find((d:any)=>d.id===driverId);
  const row = drivers.find(d=>d.driverId===driverId || (selected && driverNameKey(d.driverName)===driverNameKey(selected.name)));
  const choose = (id:string) => {
    setDriverId(id);
    const person = roster.find((d:any)=>d.id===id);
    const existing = drivers.find(d=>d.driverId===id || (person && driverNameKey(d.driverName)===driverNameKey(person.name)));
    setHub(existing?.hub === "Ocala" ? "Ocala" : existing?.hub === "Dallas" ? "Dallas" : "Birmingham");
    setHours(existing?.official ? formatMinutes(existing.officialMinutes) : "");
    setSource(existing?.official?.source ?? ""); setReason("");
  };
  const submit = () => {
    if (!selected) return toast.error("Select a driver.");
    try {
      const minutes = parseHoursMinutes(hours);
      if (!source.trim() || !reason.trim()) return toast.error("Enter a source and a reason for the correction.");
      save.mutate({driverId:row?.driverId ?? driverId,weekStart,expectedUpdatedAt:row?.revision ?? null,
        actual:{driverName:selected.name,hub:hub as "Birmingham"|"Dallas"|"Ocala",minutes,scope:"weekdays",source:source.trim(),reason:reason.trim(),
          ...(row?.official && row.officialMinutes===minutes && row.official.source===source.trim() ?
            {intervals:row.official.intervals,sourceHash:row.official.sourceHash} : {})}},
        {onSuccess:()=>{toast.success("Official warehouse hours saved. Future sweeps preserve this correction.");setReason("");},
         onError:(e:any)=>toast.error(e.message)});
    } catch(e:any) {toast.error(e.message);}
  };
  return <Card className="p-4 space-y-3 print:hidden">
    <h2 className="font-semibold">Correct warehouse hours</h2>
    <p className="text-sm text-muted-foreground">Save the verified Monday–Friday total, including 0:00. This is separate from Paycom paid hours. The original detected events and correction history remain available.</p>
    {config.data?.error && <p className="text-sm text-destructive">Driver roster unavailable: {config.data.error}</p>}
    <div className="grid gap-3 md:grid-cols-3">
      <div><Label htmlFor="actual-driver">Driver</Label><select id="actual-driver" className="h-10 w-full border rounded bg-background px-2" value={driverId} onChange={e=>choose(e.target.value)}>
        <option value="">Select a driver</option>{roster.map((d:any)=><option key={d.id} value={d.id}>{d.name}</option>)}
      </select></div>
      <div><Label htmlFor="actual-hub">Warehouse</Label><select id="actual-hub" className="h-10 w-full border rounded bg-background px-2" value={hub} onChange={e=>setHub(e.target.value)}>
        {['Birmingham','Dallas','Ocala'].map(h=><option key={h}>{h}</option>)}
      </select></div>
      <div><Label htmlFor="actual-hours">Official warehouse time (H:MM)</Label><Input id="actual-hours" value={hours} placeholder="5:30" onChange={e=>setHours(e.target.value)} /></div>
      <div className="md:col-span-2"><Label htmlFor="actual-source">Source report</Label><Input id="actual-source" value={source} onChange={e=>setSource(e.target.value)} placeholder="Report filename or reference" /></div>
      <div><Label htmlFor="actual-reason">Reason for correction</Label><Input id="actual-reason" value={reason} onChange={e=>setReason(e.target.value)} /></div>
    </div>
    <Button onClick={submit} disabled={!selected || save.isPending}>Save official warehouse hours</Button>
    {row?.official && <p className="text-xs text-muted-foreground">Current official: {formatMinutes(row.officialMinutes)} · automated: {formatMinutes(row.automatedMinutes)} · {row.history.length} recorded revision(s).</p>}
  </Card>;
}
