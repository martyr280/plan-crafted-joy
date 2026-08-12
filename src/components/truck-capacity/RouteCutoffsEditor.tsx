// Settings editor for route order cutoffs (seeded from Joe's Driver Routes
// worksheet). One route may have several cutoffs (e.g. MTN Tue 4pm + Thu 5pm).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Trash2 } from "lucide-react";
import { listRouteCutoffs, upsertRouteCutoff, deleteRouteCutoff } from "@/lib/truck-capacity.functions";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TZS = ["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles"];

type RouteLite = { id: string; code: string; name: string; hub: string };
type Draft = {
  id?: string; route_id: string; p21_code: string; cutoff_dow: number; cutoff_time: string;
  tz: string; run_dows: number[]; run_days_label: string; driver_name: string; notes: string;
  sort_order: number; active: boolean;
};

const blank = (routeId: string): Draft => ({
  route_id: routeId, p21_code: "", cutoff_dow: 2, cutoff_time: "16:00", tz: "America/Chicago",
  run_dows: [3], run_days_label: "", driver_name: "", notes: "", sort_order: 0, active: true,
});

export function RouteCutoffsEditor({ routes, canEdit }: { routes: RouteLite[]; canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useServerFn(listRouteCutoffs);
  const save = useServerFn(upsertRouteCutoff);
  const del = useServerFn(deleteRouteCutoff);
  const [draft, setDraft] = useState<Draft | null>(null);

  const q = useQuery({ queryKey: ["route-cutoffs"], queryFn: () => list({} as any) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["route-cutoffs"] });
    qc.invalidateQueries({ queryKey: ["truck-forecast-board"] });
  };

  const saveM = useMutation({
    mutationFn: (d: Draft) => save({ data: { ...d, p21_code: d.p21_code || null, run_days_label: d.run_days_label || null, driver_name: d.driver_name || null, notes: d.notes || null } }),
    onSuccess: () => { toast.success("Cutoff saved"); setDraft(null); invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });
  const delM = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => { toast.success("Cutoff removed"); invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Delete failed"),
  });

  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);
  const grouped = useMemo(() => {
    const rows = (q.data?.cutoffs ?? []) as any[];
    const byRoute = new Map<string, any[]>();
    for (const c of rows) {
      const arr = byRoute.get(c.route_id) ?? [];
      arr.push(c); byRoute.set(c.route_id, arr);
    }
    return routes
      .map((r) => ({ route: r, cutoffs: byRoute.get(r.id) ?? [] }))
      .sort((a, b) => a.route.hub.localeCompare(b.route.hub) || a.route.code.localeCompare(b.route.code));
  }, [q.data, routes]);

  const toggleRunDow = (d: number) =>
    setDraft((cur) => cur && ({ ...cur, run_dows: cur.run_dows.includes(d) ? cur.run_dows.filter((x) => x !== d) : [...cur.run_dows, d].sort() }));

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">Route order cutoffs</div>
          <div className="text-xs text-muted-foreground">
            Drives the Forecast board's "orders counted through" window. Seeded from the Driver Routes worksheet.
          </div>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" onClick={() => setDraft(blank(routes[0]?.id ?? ""))} disabled={!routes.length}>
            <Plus className="mr-2 h-4 w-4" /> Add cutoff
          </Button>
        )}
      </div>

      <Table>
        <TableHeader><TableRow>
          <TableHead>Route</TableHead><TableHead>P21 code</TableHead><TableHead>Cutoff</TableHead>
          <TableHead>Runs</TableHead><TableHead>Driver</TableHead><TableHead>Active</TableHead><TableHead />
        </TableRow></TableHeader>
        <TableBody>
          {grouped.map(({ route, cutoffs }) =>
            cutoffs.length === 0 ? (
              <TableRow key={route.id}>
                <TableCell>
                  <div className="font-medium">{route.code}</div>
                  <div className="text-xs text-muted-foreground">{route.hub}</div>
                </TableCell>
                <TableCell colSpan={6} className="text-xs text-muted-foreground">no cutoff configured</TableCell>
              </TableRow>
            ) : cutoffs.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <div className="font-medium">{route.code}</div>
                  <div className="text-xs text-muted-foreground">{route.hub}</div>
                </TableCell>
                <TableCell className="text-xs">{c.p21_code ?? "—"}</TableCell>
                <TableCell className="text-xs">{DOW[c.cutoff_dow]} {String(c.cutoff_time).slice(0, 5)} <span className="text-muted-foreground">{c.tz.split("/")[1]}</span></TableCell>
                <TableCell className="text-xs">{(c.run_dows ?? []).map((d: number) => DOW[d]).join(", ") || "—"}{c.run_days_label && <div className="text-muted-foreground">{c.run_days_label}</div>}</TableCell>
                <TableCell className="text-xs">{c.driver_name ?? "—"}</TableCell>
                <TableCell>{c.active ? <Badge variant="outline" className="text-xs">yes</Badge> : <Badge variant="secondary" className="text-xs">no</Badge>}</TableCell>
                <TableCell className="text-right">
                  {canEdit && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setDraft({
                        id: c.id, route_id: c.route_id, p21_code: c.p21_code ?? "", cutoff_dow: c.cutoff_dow,
                        cutoff_time: String(c.cutoff_time).slice(0, 5), tz: c.tz, run_dows: c.run_dows ?? [],
                        run_days_label: c.run_days_label ?? "", driver_name: c.driver_name ?? "",
                        notes: c.notes ?? "", sort_order: c.sort_order ?? 0, active: c.active,
                      })}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => delM.mutate(c.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )),
          )}
        </TableBody>
      </Table>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{draft?.id ? "Edit cutoff" : "New cutoff"}</DialogTitle></DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Route</Label>
                <Select value={draft.route_id} onValueChange={(v) => setDraft({ ...draft, route_id: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {routes.map((r) => <SelectItem key={r.id} value={r.id}>{r.hub} · {r.code} — {r.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-xs">Cutoff day</Label>
                  <Select value={String(draft.cutoff_dow)} onValueChange={(v) => setDraft({ ...draft, cutoff_dow: Number(v) })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{DOW.map((d, i) => <SelectItem key={i} value={String(i)}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Time (local)</Label>
                  <Input type="time" value={draft.cutoff_time} onChange={(e) => setDraft({ ...draft, cutoff_time: e.target.value })} />
                </div>
                <div>
                  <Label className="text-xs">Timezone</Label>
                  <Select value={draft.tz} onValueChange={(v) => setDraft({ ...draft, tz: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{TZS.map((t) => <SelectItem key={t} value={t}>{t.split("/")[1]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">Ship days fed by this cutoff</Label>
                <div className="mt-1 flex gap-1">
                  {DOW.map((d, i) => (
                    <Button key={i} type="button" size="sm" variant={draft.run_dows.includes(i) ? "default" : "outline"} onClick={() => toggleRunDow(i)}>{d}</Button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label className="text-xs">P21 code</Label><Input value={draft.p21_code} onChange={(e) => setDraft({ ...draft, p21_code: e.target.value })} placeholder="MTN01" /></div>
                <div><Label className="text-xs">Driver</Label><Input value={draft.driver_name} onChange={(e) => setDraft({ ...draft, driver_name: e.target.value })} /></div>
              </div>
              <div><Label className="text-xs">Run days label</Label><Input value={draft.run_days_label} onChange={(e) => setDraft({ ...draft, run_days_label: e.target.value })} placeholder="Wed–Thu" /></div>
              <div><Label className="text-xs">Notes</Label><Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></div>
              <div className="flex items-center gap-2">
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
                <Label className="text-xs">Active</Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button onClick={() => draft && saveM.mutate(draft)} disabled={saveM.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
