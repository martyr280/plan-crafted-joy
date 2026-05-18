import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { formatDistanceToNow } from "date-fns";
import { listDvirs, listDocuments } from "@/lib/samsara.functions";
import { Paperclip, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/damage")({ component: DamagePage });

function DamagePage() {
  const [rows, setRows] = useState<any[]>([]);
  const reload = () =>
    supabase.from("damage_reports").select("*").order("created_at", { ascending: false }).then(({ data }) => setRows(data ?? []));
  useEffect(() => { reload(); }, []);

  const open = rows.filter((r) => r.status === "open").length;
  const severe = rows.filter((r) => r.severity === "severe").length;

  return (
    <div>
      <ModuleHeader title="Damage Tracker" description="RMA log linked to Samsara DVIRs and proof-of-delivery documents." />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Open claims</p><p className="text-2xl font-bold">{open}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Severe</p><p className="text-2xl font-bold text-destructive">{severe}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Total logged</p><p className="text-2xl font-bold">{rows.length}</p></Card>
      </div>
      <Card><Table>
        <TableHeader><TableRow>
          <TableHead>When</TableHead><TableHead>P21 Order</TableHead><TableHead>Stage</TableHead>
          <TableHead>Type</TableHead><TableHead>Severity</TableHead><TableHead>Route</TableHead>
          <TableHead>Status</TableHead><TableHead>Photos</TableHead><TableHead>Samsara</TableHead>
        </TableRow></TableHeader>
        <TableBody>{rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</TableCell>
            <TableCell>{r.p21_order_id ?? "—"}</TableCell>
            <TableCell>{r.stage}</TableCell>
            <TableCell>{r.damage_type}</TableCell>
            <TableCell><Badge variant={r.severity === "severe" ? "destructive" : "secondary"}>{r.severity}</Badge></TableCell>
            <TableCell>{r.route_code}</TableCell>
            <TableCell>{r.status}</TableCell>
            <TableCell>{(r.photos as string[] | null)?.slice(0, 1).map((p, i) => <img key={i} src={p} alt="damage" className="w-12 h-12 object-cover rounded" />)}</TableCell>
            <TableCell><AttachSamsaraCell row={r} onChanged={reload} /></TableCell>
          </TableRow>))}</TableBody>
      </Table></Card>
    </div>
  );
}

function AttachSamsaraCell({ row, onChanged }: { row: any; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const getDvirs = useServerFn(listDvirs);
  const getDocs = useServerFn(listDocuments);

  const dvirs = useQuery({
    queryKey: ["samsara", "dvirs", 168],
    queryFn: () => getDvirs({ data: { hours: 168 } }),
    enabled: open,
  });
  const docs = useQuery({
    queryKey: ["samsara", "documents", 336],
    queryFn: () => getDocs({ data: { hours: 336 } }),
    enabled: open,
  });

  const items = useMemo(() => {
    const d = (dvirs.data?.dvirs ?? []).map((x: any) => ({
      kind: "DVIR" as const,
      id: String(x.id),
      label: `DVIR · ${x.vehicle?.name ?? x.vehicle?.id ?? "?"}`,
      sub: `${x.driver?.name ?? "—"} · ${x.inspectionType ?? ""}`,
      ts: x.endTime ?? x.startTime,
    }));
    const o = (docs.data?.documents ?? []).map((x: any) => ({
      kind: "Doc" as const,
      id: String(x.id),
      label: `${x.documentType?.name ?? "Document"} · ${x.vehicle?.name ?? x.vehicle?.id ?? "?"}`,
      sub: `${x.driver?.name ?? "—"} · ${x.notes ?? ""}`,
      ts: x.createdAtTime,
    }));
    const all = [...d, ...o].sort((a, b) => String(b.ts ?? "").localeCompare(String(a.ts ?? "")));
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((i) => `${i.label} ${i.sub} ${i.id}`.toLowerCase().includes(needle)) : all;
  }, [dvirs.data, docs.data, q]);

  async function attach(id: string) {
    const { error } = await supabase.from("damage_reports").update({ samsara_document_id: id }).eq("id", row.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Samsara reference attached");
    setOpen(false);
    onChanged();
  }
  async function detach() {
    const { error } = await supabase.from("damage_reports").update({ samsara_document_id: null }).eq("id", row.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Reference removed");
    onChanged();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {row.samsara_document_id ? (
          <Button variant="ghost" size="sm" className="gap-1 text-success">
            <CheckCircle2 className="w-3.5 h-3.5" /> Linked
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="gap-1">
            <Paperclip className="w-3.5 h-3.5" /> Attach
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach Samsara DVIR or Document</DialogTitle>
        </DialogHeader>

        {row.samsara_document_id && (
          <div className="flex items-center justify-between p-2 rounded bg-muted text-sm">
            <span>Currently linked: <span className="font-mono">{row.samsara_document_id}</span></span>
            <Button variant="ghost" size="sm" onClick={detach}>Remove</Button>
          </div>
        )}

        <Input placeholder="Filter by driver, vehicle, ID…" value={q} onChange={(e) => setQ(e.target.value)} />

        <div className="max-h-96 overflow-auto border rounded">
          {(dvirs.isLoading || docs.isLoading) ? (
            <p className="p-4 text-sm text-muted-foreground">Loading Samsara records…</p>
          ) : (dvirs.data?.error || docs.data?.error) ? (
            <p className="p-4 text-sm text-destructive">{dvirs.data?.error || docs.data?.error}</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matching DVIRs or documents.</p>
          ) : (
            <ul className="divide-y">
              {items.slice(0, 100).map((i) => (
                <li key={`${i.kind}-${i.id}`} className="p-3 flex items-center justify-between hover:bg-muted/40">
                  <div className="min-w-0">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{i.kind}</Badge>
                      <span className="truncate">{i.label}</span>
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{i.sub} · {i.ts ? formatDistanceToNow(new Date(i.ts), { addSuffix: true }) : ""}</p>
                  </div>
                  <Button size="sm" onClick={() => attach(i.id)}>Attach</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
