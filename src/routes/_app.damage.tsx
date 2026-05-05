import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_app/damage")({ component: DamagePage });

function DamagePage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { supabase.from("damage_reports").select("*").order("created_at", { ascending: false }).then(({ data }) => setRows(data ?? [])); }, []);

  const open = rows.filter((r) => r.status === "open").length;
  const severe = rows.filter((r) => r.severity === "severe").length;

  return (
    <div>
      <ModuleHeader title="Damage Tracker" description="RMA log linked to Samsara photo evidence." />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Open claims</p><p className="text-2xl font-bold">{open}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Severe</p><p className="text-2xl font-bold text-destructive">{severe}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Total logged</p><p className="text-2xl font-bold">{rows.length}</p></Card>
      </div>
      <Card><Table>
        <TableHeader><TableRow><TableHead>When</TableHead><TableHead>P21 Order</TableHead><TableHead>Stage</TableHead><TableHead>Type</TableHead><TableHead>Severity</TableHead><TableHead>Route</TableHead><TableHead>Status</TableHead><TableHead>Photos</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</TableCell>
            <TableCell>{r.p21_order_id ?? "—"}</TableCell>
            <TableCell>{r.stage}</TableCell>
            <TableCell>{r.damage_type}</TableCell>
            <TableCell><Badge variant={r.severity === "severe" ? "destructive" : "secondary"}>{r.severity}</Badge></TableCell>
            <TableCell>{r.route_code}</TableCell>
            <TableCell>{r.status}</TableCell>
            <TableCell>{(r.photos as string[]).slice(0, 1).map((p, i) => <img key={i} src={p} alt="damage" className="w-12 h-12 object-cover rounded" />)}</TableCell>
          </TableRow>))}</TableBody>
      </Table></Card>
    </div>
  );
}
