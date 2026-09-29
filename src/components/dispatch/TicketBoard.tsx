import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CalendarX, FileDown, Info, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useDeleteRunException, useDispatchBoard, useRefreshDispatchBoard, useSaveRunException } from "@/hooks/useDispatch";
import { DATE_BASES, DATE_BASIS_LABEL, type DateBasis } from "@/lib/dispatch/assign";
import type { DispatchBoard, RunException, TicketView } from "@/lib/dispatch/board";
import type { RolledFrom } from "@/lib/dispatch/assign";
import { toCsv } from "@/lib/sales-reports.drilldown";

const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayLabel = (iso: string) => `${DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(5)}`;
const runCell = (v: string | null) => (v == null ? "—" : v.startsWith("stale:") ? `stale (${v.slice(6)})` : dayLabel(v));

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDay = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const REASON_LABEL: Record<string, string> = { short_week: "Short week", driver_pto: "Driver PTO", other: "Other" };
const KIND_LABEL: Record<string, string> = { no_run: "No run", reduced: "Reduced" };
const rolledText = (r: RolledFrom | null) => (r ? `Rolled from ${longDay(r.runDate)} (${REASON_LABEL[r.reason] ?? r.reason})` : "");

function ExceptionBadge({ e }: { e: RunException }) {
  const badge = <Badge variant="outline" className={e.kind === "no_run" ? "border-destructive text-destructive" : "border-amber-500 text-amber-600"}>{KIND_LABEL[e.kind]} — {REASON_LABEL[e.reason]}</Badge>;
  if (!e.note) return badge;
  return <TooltipProvider><Tooltip><TooltipTrigger>{badge}</TooltipTrigger><TooltipContent className="max-w-xs">{e.note}</TooltipContent></Tooltip></TooltipProvider>;
}

function MarkRunDialog({ code, date, onClose }: { code: string; date: string; onClose: () => void }) {
  const save = useSaveRunException();
  const [kind, setKind] = useState<"no_run" | "reduced">("no_run");
  const [reason, setReason] = useState<"short_week" | "driver_pto" | "other">("driver_pto");
  const [note, setNote] = useState("");
  const submit = async () => {
    try { await save.mutateAsync({ p21Code: code, runDate: date, kind, reason, note: note || null }); toast.success(`${code} ${longDay(date)} marked`); onClose(); }
    catch (e: any) { toast.error(e?.message ?? "Could not save"); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Mark run {code} · {longDay(date)}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>What happens</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as any)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="no_run">No run (tickets roll to next run)</SelectItem><SelectItem value="reduced">Short a driver / reduced</SelectItem></SelectContent></Select></div>
          <div><Label>Reason</Label>
            <Select value={reason} onValueChange={(v) => setReason(v as any)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="short_week">Short week</SelectItem><SelectItem value="driver_pto">Driver PTO</SelectItem><SelectItem value="other">Other</SelectItem></SelectContent></Select></div>
          <div><Label>Note (optional)</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={save.isPending}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveException({ e }: { e: RunException }) {
  const del = useDeleteRunException();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild><Button size="sm" variant="ghost" aria-label="Remove exception"><Trash2 className="w-4 h-4" /></Button></AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Remove exception?</AlertDialogTitle>
          <AlertDialogDescription>{e.p21_code} {longDay(e.run_date)} goes back to a normal run. Tickets that rolled will return to it.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={async () => { try { await del.mutateAsync(e.id); toast.success("Exception removed"); } catch (x: any) { toast.error(x?.message ?? "Could not remove"); } }}>Remove</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export function TicketBoard({ isAdmin = false }: { isAdmin?: boolean }) {
  const q = useDispatchBoard();
  const refresh = useRefreshDispatchBoard();
  const b = q.data as (DispatchBoard & { jobId: string | null; pulledAt: string | null }) | null | undefined;

  const onRefresh = async () => {
    try { const r: any = await refresh.mutateAsync(); toast.success(`Pulled ${r.totalRows} tickets from P21`); }
    catch (e: any) { toast.error(e?.message ?? "Bridge pull failed"); }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 flex flex-wrap items-center gap-3">
        <div className="text-sm">
          <div className="font-medium">Pick tickets by route cutoff</div>
          <div className="text-muted-foreground">
            {b ? <>Date basis: <b>{DATE_BASIS_LABEL[b.basis]}</b> · {b.totalRows} rows · {b.excluded} excluded (WCALL/LTL01) · {b.held} held short · pulled {b.pulledAt ? new Date(b.pulledAt).toLocaleString("en-US", { timeZone: "America/Chicago" }) : "—"}</> : q.isLoading ? "Loading…" : "No pull yet. Refresh to read the P21 view."}
          </div>
        </div>
        <Button className="ml-auto" size="sm" variant="outline" onClick={onRefresh} disabled={refresh.isPending}>
          {refresh.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span className="ml-2">Refresh from P21</span>
        </Button>
      </Card>
      {b && (
        <Tabs defaultValue="upcoming">
          <TabsList>
            <TabsTrigger value="upcoming">Upcoming runs ({b.upcoming.length})</TabsTrigger>
            <TabsTrigger value="stale">Stale tickets ({b.stale.length})</TabsTrigger>
            <TabsTrigger value="unrouted">Unrouted ({b.unrouted.length + b.noCutoff.length})</TabsTrigger>
            <TabsTrigger value="datecheck">Date check</TabsTrigger>
          </TabsList>
          <TabsContent value="upcoming"><Upcoming b={b} isAdmin={isAdmin} /></TabsContent>
          <TabsContent value="stale"><Stale b={b} /></TabsContent>
          <TabsContent value="unrouted"><Unrouted b={b} /></TabsContent>
          <TabsContent value="datecheck"><DateCheck b={b} /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Upcoming({ b, isAdmin }: { b: DispatchBoard; isAdmin: boolean }) {
  const [mark, setMark] = useState<{ code: string; date: string } | null>(null);
  const cols = isAdmin ? 9 : 8;
  return (
    <div className="space-y-4">
    {mark && <MarkRunDialog code={mark.code} date={mark.date} onClose={() => setMark(null)} />}
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Route</TableHead><TableHead>Run date</TableHead>
            <TableHead className="text-right">Tickets</TableHead><TableHead className="text-right">Held (short)</TableHead>
            <TableHead className="text-right">Est cube</TableHead><TableHead className="text-right">Est weight</TableHead>
            <TableHead>
              <TooltipProvider><Tooltip><TooltipTrigger className="inline-flex items-center gap-1">Nelson demand <Info className="w-3 h-3" /></TooltipTrigger>
                <TooltipContent className="max-w-xs">Latest Truck Capacity demand snapshot for the same route and date. No pallet column: est_pallets is empty on every row of the P21 view.</TooltipContent></Tooltip></TooltipProvider>
            </TableHead>
            <TableHead>Exception</TableHead>
            {isAdmin && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {b.upcoming.length === 0 && <TableRow><TableCell colSpan={cols} className="text-muted-foreground">No tickets assigned to a run from today onward.</TableCell></TableRow>}
          {b.upcoming.map((r) => (
            <TableRow key={`${r.route_code}|${r.run_date}`}>
              <TableCell className="font-medium">{r.route_code}</TableCell>
              <TableCell>{dayLabel(r.run_date)}{(() => { const rolled = r.ticketList.filter((t) => t.rolled_from); if (!rolled.length) return null; const byFrom = new Map<string, number>(); for (const t of rolled) { const k = rolledText(t.rolled_from); byFrom.set(k, (byFrom.get(k) ?? 0) + 1); } return [...byFrom].map(([k, n]) => <div key={k} className="text-xs text-muted-foreground">{n} × {k}</div>); })()}</TableCell>
              <TableCell className="text-right tabular-nums">{r.tickets}</TableCell>
              <TableCell className="text-right">{r.held ? <Badge variant="outline" className="border-amber-500 text-amber-600">{r.held}</Badge> : "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{n0(r.est_cube_ft)} ft³{r.missing_cube > 0 && <span className="ml-1 text-xs text-muted-foreground">({r.missing_cube} missing cube)</span>}</TableCell>
              <TableCell className="text-right tabular-nums">{n0(r.est_weight_lbs)} lb{r.missing_weight > 0 && <span className="ml-1 text-xs text-muted-foreground">({r.missing_weight} missing)</span>}</TableCell>
              <TableCell className="text-sm">
                {r.demand ? (
                  <div>
                    <div>{r.demand.order_count ?? "—"} orders · {n0(r.demand.total_cube_ft)} ft³ · {r.demand.projected_capacity_frac == null ? "—" : `${Math.round(r.demand.projected_capacity_frac * 100)}%`}</div>
                    <div className="text-xs text-muted-foreground">Printed so far: {r.orders} of {r.demand.order_count ?? "—"} orders</div>
                  </div>
                ) : <span className="text-muted-foreground">no demand snapshot</span>}
              </TableCell>
              <TableCell>{r.exception ? <ExceptionBadge e={r.exception} /> : "—"}</TableCell>
              {isAdmin && <TableCell>{r.exception ? <RemoveException e={r.exception} /> : <Button size="sm" variant="outline" onClick={() => setMark({ code: r.route_code, date: r.run_date })}><CalendarX className="w-4 h-4 mr-1" />Mark run</Button>}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
    <Card className="overflow-hidden">
      <div className="p-3 text-sm font-medium">Run exceptions (today onward)</div>
      <Table>
        <TableHeader><TableRow><TableHead>Route</TableHead><TableHead>Date</TableHead><TableHead>Kind</TableHead><TableHead>Reason</TableHead><TableHead>Note</TableHead><TableHead>Set by</TableHead>{isAdmin && <TableHead />}</TableRow></TableHeader>
        <TableBody>
          {b.exceptions.length === 0 && <TableRow><TableCell colSpan={isAdmin ? 7 : 6} className="text-muted-foreground">No upcoming exceptions.</TableCell></TableRow>}
          {b.exceptions.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="font-medium">{e.p21_code}</TableCell><TableCell>{longDay(e.run_date)}</TableCell>
              <TableCell>{KIND_LABEL[e.kind]}</TableCell><TableCell>{REASON_LABEL[e.reason]}</TableCell>
              <TableCell className="text-sm">{e.note ?? "—"}</TableCell><TableCell className="text-sm">{e.created_by_name ?? "—"}</TableCell>
              {isAdmin && <TableCell><RemoveException e={e} /></TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
    </div>
  );
}

function Stale({ b }: { b: DispatchBoard }) {
  return (
    <Card className="overflow-hidden">
      <p className="p-3 text-sm text-muted-foreground">Tickets whose run date under the current date basis is before today. They are never put on a current run.</p>
      <Table>
        <TableHeader><TableRow><TableHead>Route</TableHead><TableHead>Pick ticket</TableHead><TableHead>Order</TableHead><TableHead>Customer</TableHead><TableHead>Print date</TableHead><TableHead className="text-right">Age (days)</TableHead><TableHead>Would-be run</TableHead><TableHead>Hold</TableHead></TableRow></TableHeader>
        <TableBody>
          {b.stale.map((t, i) => (
            <TableRow key={i}>
              <TableCell>{t.route_code}</TableCell><TableCell>{t.pick_ticket_no}</TableCell><TableCell>{t.order_no}</TableCell>
              <TableCell>{t.customer_name}</TableCell><TableCell>{t.print_date ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums">{t.age_days ?? "—"}</TableCell><TableCell>{t.run_date}</TableCell>
              <TableCell className="text-xs text-amber-600">{t.hold_reason ?? ""}{t.rolled_from && <div className="text-muted-foreground">{rolledText(t.rolled_from)}</div>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Unrouted({ b }: { b: DispatchBoard }) {
  const rows = [...b.unrouted.map((t) => ({ t, why: "No route code" })), ...b.noCutoff.map((t) => ({ t, why: "No cutoff for route / no date" }))];
  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader><TableRow><TableHead>Why</TableHead><TableHead>Route</TableHead><TableHead>Pick ticket</TableHead><TableHead>Order</TableHead><TableHead>Customer</TableHead><TableHead>City</TableHead><TableHead>Print date</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map(({ t, why }, i) => (
            <TableRow key={i}><TableCell>{why}</TableCell><TableCell>{t.route_code ?? "—"}</TableCell><TableCell>{t.pick_ticket_no}</TableCell><TableCell>{t.order_no}</TableCell><TableCell>{t.customer_name}</TableCell><TableCell>{[t.ship2_city, t.ship2_state].filter(Boolean).join(", ")}</TableCell><TableCell>{t.print_date ?? "—"}</TableCell></TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function DateCheck({ b }: { b: DispatchBoard }) {
  const rows = useMemo(() => [...b.dateCheck].sort((x, y) => String(x.route_code ?? "").localeCompare(String(y.route_code ?? "")) || String(x.pick_ticket_no).localeCompare(String(y.pick_ticket_no))), [b]);
  const disagree = rows.filter((r) => r.bases_disagree).length;
  const exportCsv = () => {
    const head = ["Route", "Pick ticket", "Order", "Ship-to city", "Print date", "Earliest required", "Latest required", "Requested", "Promise", "Original promise", ...DATE_BASES.map((k) => `Run by ${DATE_BASIS_LABEL[k]}`), "Bases disagree", "rolled_from"];
    const body = rows.map((t) => [t.route_code, t.pick_ticket_no, t.order_no, t.ship2_city, t.print_date, t.earliest_required, t.latest_required, t.requested, t.promise, t.original_promise, ...DATE_BASES.map((k) => t.runByBasis[k]), t.bases_disagree ? "Y" : "N", t.rolled_from ? `${t.rolled_from.runDate} (${REASON_LABEL[t.rolled_from.reason]})` : ""]);
    download(`dispatch-date-check-${b.today}.csv`, toCsv(head, body));
  };
  const hi = (t: TicketView, k: DateBasis) => t.bases_disagree && t.runByBasis[k] !== t.runByBasis.pick_ticket_print ? "bg-amber-500/15" : "";
  return (
    <Card className="overflow-hidden">
      <div className="p-3 flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">One row per ticket. Highlighted cells pick a different run than the pick-ticket print date. {disagree} of {rows.length} tickets disagree.</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={exportCsv}><FileDown className="w-4 h-4 mr-1" /> Export CSV</Button>
      </div>
      <div className="overflow-auto max-h-[70vh]">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Route</TableHead><TableHead>Pick ticket</TableHead><TableHead>Order</TableHead><TableHead>Ship-to city</TableHead>
            <TableHead>Print</TableHead><TableHead>Earliest req.</TableHead><TableHead>Latest req.</TableHead><TableHead>Requested</TableHead><TableHead>Promise</TableHead><TableHead>Orig. promise</TableHead>
            {DATE_BASES.map((k) => <TableHead key={k}>Run: {DATE_BASIS_LABEL[k].replace(" date", "")}</TableHead>)}<TableHead>Rolled from</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((t, i) => (
              <TableRow key={i}>
                <TableCell>{t.route_code ?? "—"}</TableCell><TableCell>{t.pick_ticket_no}</TableCell><TableCell>{t.order_no}</TableCell><TableCell>{t.ship2_city}</TableCell>
                <TableCell>{t.print_date ?? "—"}</TableCell><TableCell>{t.earliest_required ?? "—"}</TableCell><TableCell>{t.latest_required ?? "—"}</TableCell>
                <TableCell>{t.requested ?? "—"}</TableCell><TableCell>{t.promise ?? "—"}</TableCell><TableCell>{t.original_promise ?? "—"}</TableCell>
                {DATE_BASES.map((k) => <TableCell key={k} className={`whitespace-nowrap ${hi(t, k)}`}>{runCell(t.runByBasis[k])}</TableCell>)}<TableCell className="text-xs whitespace-nowrap">{rolledText(t.rolled_from) || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
