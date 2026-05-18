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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { format, formatDistanceToNow } from "date-fns";
import { listDvirs, listDocuments } from "@/lib/samsara.functions";
import { Paperclip, CheckCircle2, CalendarIcon, X, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { DateRange } from "react-day-picker";

export const Route = createFileRoute("/_app/damage")({ component: DamagePage });

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// Page through all rows — PostgREST caps responses at 1000.
async function fetchAllDamage() {
  const out: any[] = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await supabase
      .from("damage_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + step - 1);
    if (error) break;
    out.push(...(data ?? []));
    if (!data || data.length < step) break;
  }
  return out;
}

function DamagePage() {
  const [rows, setRows] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [severity, setSeverity] = useState<string>("all");
  const [stage, setStage] = useState<string>("all");
  const [range, setRange] = useState<DateRange | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const reload = () => fetchAllDamage().then(setRows);
  useEffect(() => { reload(); }, []);

  // Reset to page 1 whenever filters change.
  useEffect(() => { setPage(1); }, [search, status, severity, stage, range?.from, range?.to, pageSize]);

  const stages = useMemo(() => Array.from(new Set(rows.map((r) => r.stage).filter(Boolean))).sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromMs = range?.from ? new Date(range.from).setHours(0, 0, 0, 0) : null;
    const toMs = range?.to ? new Date(range.to).setHours(23, 59, 59, 999) : fromMs;
    return rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (severity !== "all" && r.severity !== severity) return false;
      if (stage !== "all" && r.stage !== stage) return false;
      if (fromMs != null) {
        const t = new Date(r.created_at).getTime();
        if (t < fromMs || (toMs != null && t > toMs)) return false;
      }
      if (q) {
        const hay = `${r.p21_order_id ?? ""} ${r.route_code ?? ""} ${r.driver_name ?? ""} ${r.damage_type ?? ""} ${r.dealer_id ?? ""} ${r.installer_id ?? ""} ${r.resolution ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, status, severity, stage, range]);

  const open = filtered.filter((r) => r.status === "open").length;
  const severe = filtered.filter((r) => r.severity === "severe").length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const pageRows = filtered.slice(startIdx, startIdx + pageSize);
  const hasFilters = !!(search || status !== "all" || severity !== "all" || stage !== "all" || range?.from);

  return (
    <div>
      <ModuleHeader title="Damage Tracker" description="RMA log linked to Samsara DVIRs and proof-of-delivery documents." />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Open (filtered)</p><p className="text-2xl font-bold">{open}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Severe (filtered)</p><p className="text-2xl font-bold text-destructive">{severe}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Matching / total</p><p className="text-2xl font-bold">{filtered.length} <span className="text-sm font-normal text-muted-foreground">/ {rows.length}</span></p></Card>
      </div>

      <Card className="p-3 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search order, route, driver, type…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_review">In review</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="minor">Minor</SelectItem>
              <SelectItem value="moderate">Moderate</SelectItem>
              <SelectItem value="severe">Severe</SelectItem>
            </SelectContent>
          </Select>
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Stage" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {stages.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn("justify-start text-left font-normal", !range?.from && "text-muted-foreground")}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {range?.from ? (
                  range.to ? `${format(range.from, "LLL d")} – ${format(range.to, "LLL d, y")}` : format(range.from, "LLL d, y")
                ) : "Date range"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={range}
                onSelect={setRange}
                numberOfMonths={2}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setSearch(""); setStatus("all"); setSeverity("all"); setStage("all"); setRange(undefined); }}
            >
              <X className="w-3 h-3 mr-1" /> Clear
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <Table>
          <TableHeader><TableRow>
            <TableHead>When</TableHead><TableHead>P21 Order</TableHead><TableHead>Stage</TableHead>
            <TableHead>Type</TableHead><TableHead>Severity</TableHead><TableHead>Route</TableHead>
            <TableHead>Status</TableHead><TableHead>Photos</TableHead><TableHead>Samsara</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                {rows.length === 0 ? "No damage reports recorded." : "No reports match the current filters."}
              </TableCell></TableRow>
            ) : pageRows.map((r) => (
              <TableRow key={r.id}>
                <TableCell title={new Date(r.created_at).toLocaleString()}>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</TableCell>
                <TableCell>{r.p21_order_id ?? "—"}</TableCell>
                <TableCell>{r.stage}</TableCell>
                <TableCell>{r.damage_type}</TableCell>
                <TableCell><Badge variant={r.severity === "severe" ? "destructive" : "secondary"}>{r.severity}</Badge></TableCell>
                <TableCell>{r.route_code}</TableCell>
                <TableCell>{r.status}</TableCell>
                <TableCell>{(r.photos as string[] | null)?.slice(0, 1).map((p, i) => <img key={i} src={p} alt="damage" className="w-12 h-12 object-cover rounded" />)}</TableCell>
                <TableCell><AttachSamsaraCell row={r} onChanged={reload} /></TableCell>
              </TableRow>))}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between gap-3 p-3 border-t flex-wrap">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              {filtered.length === 0 ? "0" : `${startIdx + 1}–${Math.min(startIdx + pageSize, filtered.length)}`} of {filtered.length}
            </span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="w-24 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="w-4 h-4" /> Prev
            </Button>
            <span className="text-sm">Page {safePage} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </Card>
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
