import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FileDown, Info, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useDispatchBoard, useRefreshDispatchBoard } from "@/hooks/useDispatch";
import { DATE_BASES, DATE_BASIS_LABEL, type DateBasis } from "@/lib/dispatch/assign";
import type { DispatchBoard, TicketView } from "@/lib/dispatch/board";
import { toCsv } from "@/lib/sales-reports.drilldown";

const n0 = (v: number | null | undefined) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayLabel = (iso: string) => `${DOW[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(5)}`;
const runCell = (v: string | null) => (v == null ? "—" : v.startsWith("stale:") ? `stale (${v.slice(6)})` : dayLabel(v));

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

export function TicketBoard() {
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
          <TabsContent value="upcoming"><Upcoming b={b} /></TabsContent>
          <TabsContent value="stale"><Stale b={b} /></TabsContent>
          <TabsContent value="unrouted"><Unrouted b={b} /></TabsContent>
          <TabsContent value="datecheck"><DateCheck b={b} /></TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Upcoming({ b }: { b: DispatchBoard }) {
  return (
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {b.upcoming.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">No tickets assigned to a run from today onward.</TableCell></TableRow>}
          {b.upcoming.map((r) => (
            <TableRow key={`${r.route_code}|${r.run_date}`}>
              <TableCell className="font-medium">{r.route_code}</TableCell>
              <TableCell>{dayLabel(r.run_date)}</TableCell>
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
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
              <TableCell className="text-xs text-amber-600">{t.hold_reason ?? ""}</TableCell>
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
    const head = ["Route", "Pick ticket", "Order", "Ship-to city", "Print date", "Earliest required", "Latest required", "Requested", "Promise", "Original promise", ...DATE_BASES.map((k) => `Run by ${DATE_BASIS_LABEL[k]}`), "Bases disagree"];
    const body = rows.map((t) => [t.route_code, t.pick_ticket_no, t.order_no, t.ship2_city, t.print_date, t.earliest_required, t.latest_required, t.requested, t.promise, t.original_promise, ...DATE_BASES.map((k) => t.runByBasis[k]), t.bases_disagree ? "Y" : "N"]);
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
            {DATE_BASES.map((k) => <TableHead key={k}>Run: {DATE_BASIS_LABEL[k].replace(" date", "")}</TableHead>)}
          </TableRow></TableHeader>
          <TableBody>
            {rows.map((t, i) => (
              <TableRow key={i}>
                <TableCell>{t.route_code ?? "—"}</TableCell><TableCell>{t.pick_ticket_no}</TableCell><TableCell>{t.order_no}</TableCell><TableCell>{t.ship2_city}</TableCell>
                <TableCell>{t.print_date ?? "—"}</TableCell><TableCell>{t.earliest_required ?? "—"}</TableCell><TableCell>{t.latest_required ?? "—"}</TableCell>
                <TableCell>{t.requested ?? "—"}</TableCell><TableCell>{t.promise ?? "—"}</TableCell><TableCell>{t.original_promise ?? "—"}</TableCell>
                {DATE_BASES.map((k) => <TableCell key={k} className={`whitespace-nowrap ${hi(t, k)}`}>{runCell(t.runByBasis[k])}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
