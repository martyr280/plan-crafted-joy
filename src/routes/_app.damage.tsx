import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { zodValidator, fallback, stripSearchParams } from "@tanstack/zod-adapter";
import { z } from "zod";
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

const PAGE_SIZE_OPTIONS = [25, 50, 100];

const defaults = {
  search: "",
  status: "all",
  severity: "all",
  stage: "all",
  page: 1,
  pageSize: 25,
  sortKey: "when",
  sortDir: "desc",
} as const;

const damageSearchSchema = z.object({
  search: fallback(z.string(), "").default(""),
  status: fallback(z.string(), "all").default("all"),
  severity: fallback(z.string(), "all").default("all"),
  stage: fallback(z.string(), "all").default("all"),
  from: z.string().optional(),
  to: z.string().optional(),
  page: fallback(z.number(), 1).default(1),
  pageSize: fallback(z.number(), 25).default(25),
  sortKey: fallback(z.enum(["when", "severity", "status"]), "when").default("when"),
  sortDir: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
});

export const Route = createFileRoute("/_app/damage")({
  validateSearch: zodValidator(damageSearchSchema),
  search: { middlewares: [stripSearchParams(defaults)] },
  component: DamagePage,
});

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

function SortableHead({ label, col, sortKey, sortDir, onClick }: {
  label: string;
  col: "when" | "severity" | "status";
  sortKey: "when" | "severity" | "status";
  sortDir: "asc" | "desc";
  onClick: (col: "when" | "severity" | "status") => void;
}) {
  const active = sortKey === col;
  const Icon = !active ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onClick(col)}
        className={cn("inline-flex items-center gap-1 hover:text-foreground transition-colors", active ? "text-foreground font-medium" : "text-muted-foreground")}
      >
        {label}
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}

function DamagePage() {
  const [rows, setRows] = useState<any[]>([]);
  const navigate = useNavigate({ from: "/_app/damage" });
  const {
    search,
    status,
    severity,
    stage,
    from: dateFrom,
    to: dateTo,
    page,
    pageSize,
    sortKey,
    sortDir,
  } = Route.useSearch();

  const range: DateRange | undefined = useMemo(() => {
    if (!dateFrom) return undefined;
    return {
      from: new Date(dateFrom),
      to: dateTo ? new Date(dateTo) : undefined,
    };
  }, [dateFrom, dateTo]);

  const toggleSort = (key: "when" | "severity" | "status") => {
    if (sortKey === key) {
      navigate({ search: (prev) => ({ ...prev, sortDir: sortDir === "asc" ? "desc" : "asc", page: 1 }) });
    } else {
      navigate({ search: (prev) => ({ ...prev, sortKey: key, sortDir: key === "when" ? "desc" : "asc", page: 1 }) });
    }
  };

  const reload = () => fetchAllDamage().then(setRows);
  useEffect(() => { reload(); }, []);

  const stages = useMemo(() => Array.from(new Set(rows.map((r) => r.stage).filter(Boolean))).sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromMs = dateFrom ? new Date(dateFrom).setHours(0, 0, 0, 0) : null;
    const toMs = dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : fromMs;
    const out = rows.filter((r) => {
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
    const sevRank: Record<string, number> = { minor: 1, moderate: 2, severe: 3 };
    const statusRank: Record<string, number> = { open: 1, in_review: 2, in_progress: 2, pending: 2, resolved: 3, closed: 4 };
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: any, b: any): number => {
      if (sortKey === "when") return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
      if (sortKey === "severity") return ((sevRank[a.severity] ?? 0) - (sevRank[b.severity] ?? 0)) * dir;
      return ((statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99)) * dir
        || String(a.status ?? "").localeCompare(String(b.status ?? "")) * dir;
    };
    return out.sort(cmp);
  }, [rows, search, status, severity, stage, dateFrom, dateTo, sortKey, sortDir]);

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
            onChange={(e) => navigate({ search: (prev) => ({ ...prev, search: e.target.value, page: 1 }) })}
            className="max-w-xs"
          />
          <Select value={status} onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, status: v, page: 1 }) })}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="in_review">In review</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={severity} onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, severity: v, page: 1 }) })}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Severity" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="minor">Minor</SelectItem>
              <SelectItem value="moderate">Moderate</SelectItem>
              <SelectItem value="severe">Severe</SelectItem>
            </SelectContent>
          </Select>
          <Select value={stage} onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, stage: v, page: 1 }) })}>
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
                onSelect={(r) =>
                  navigate({
                    search: (prev) => ({
                      ...prev,
                      from: r?.from?.toISOString(),
                      to: r?.to?.toISOString(),
                      page: 1,
                    }),
                  })
                }
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
              onClick={() =>
                navigate({
                  search: (prev) => ({
                    ...prev,
                    search: "",
                    status: "all",
                    severity: "all",
                    stage: "all",
                    from: undefined,
                    to: undefined,
                    page: 1,
                  }),
                })
              }
            >
              <X className="w-3 h-3 mr-1" /> Clear
            </Button>
          )}
        </div>
      </Card>

      <Card>
        <Table>
          <TableHeader><TableRow>
            <SortableHead label="When" col="when" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
            <TableHead>P21 Order</TableHead><TableHead>Stage</TableHead>
            <TableHead>Type</TableHead>
            <SortableHead label="Severity" col="severity" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
            <TableHead>Route</TableHead>
            <SortableHead label="Status" col="status" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
            <TableHead>Photos</TableHead><TableHead>Samsara</TableHead>
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
            <Select value={String(pageSize)} onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, pageSize: Number(v), page: 1 }) })}>
              <SelectTrigger className="w-24 h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => navigate({ search: (prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }) })}>
              <ChevronLeft className="w-4 h-4" /> Prev
            </Button>
            <span className="text-sm">Page {safePage} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => navigate({ search: (prev) => ({ ...prev, page: Math.min(totalPages, prev.page + 1) }) })}>
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
