import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshCw, Download, Loader2, CheckCircle2, AlertCircle, ArrowUpDown, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { syncE2GReport } from "@/lib/p21.functions";

export const Route = createFileRoute("/_app/reports/e2g")({ component: E2GReportPage });

const PAGE_SIZE = 100;

type Row = {
  item_id: string;
  item_desc: string | null;
  birm: number | null;
  dallas: number | null;
  ocala: number | null;
  total: number | null;
  e2g_price: number | null;
  weight: number | null;
  net_weight: number | null;
  next_due_date: string | null;
  next_due_in_display: string | null;
  next_due_in_2: string | null;
  synced_at: string;
};

type SortKey = keyof Row;

function csvDownload(name: string, rows: any[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

async function fetchAllSnapshot(): Promise<Row[]> {
  const out: Row[] = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const { data, error } = await supabase
      .from("e2g_inventory_snapshot")
      .select("item_id, item_desc, birm, dallas, ocala, total, e2g_price, weight, net_weight, next_due_date, next_due_in_display, next_due_in_2, synced_at")
      .order("item_id", { ascending: true })
      .range(from, from + step - 1);
    if (error) throw error;
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < step) break;
  }
  return out;
}

function E2GReportPage() {
  const runSync = useServerFn(syncE2GReport);
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("item_id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["e2g_inventory_snapshot"],
    queryFn: fetchAllSnapshot,
  });

  const lastSyncedAt = rows[0]?.synced_at ?? null;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const arr = q
      ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q))
      : rows.slice();
    arr.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, filter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
    setPage(0);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await runSync();
      toast.success(`E2G sync complete — imported ${res.imported.toLocaleString()} items`);
      await qc.invalidateQueries({ queryKey: ["e2g_inventory_snapshot"] });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setSyncError(msg);
      toast.error(`E2G sync failed: ${msg}`);
    } finally {
      setSyncing(false);
    }
  }

  const cols: { key: SortKey; label: string; align?: "right" }[] = [
    { key: "item_id", label: "Item" },
    { key: "item_desc", label: "Description" },
    { key: "birm", label: "Birm", align: "right" },
    { key: "dallas", label: "Dallas", align: "right" },
    { key: "ocala", label: "Ocala", align: "right" },
    { key: "total", label: "Total", align: "right" },
    { key: "e2g_price", label: "E2G Price", align: "right" },
    { key: "weight", label: "Weight", align: "right" },
    { key: "net_weight", label: "Net Wt", align: "right" },
    { key: "next_due_date", label: "Next Due" },
  ];

  return (
    <div>
      <ModuleHeader
        title="E2G Combined Report"
        description="Customer inventory snapshot for E2G, sourced from P21. Independent of the pricer."
        actions={
          <Link to="/reports">
            <Button variant="ghost" size="sm"><ChevronLeft className="w-4 h-4 mr-1" /> All reports</Button>
          </Link>
        }
      />

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            {syncError ? (
              <><AlertCircle className="w-3.5 h-3.5 text-destructive" /><span className="text-destructive">{syncError}</span></>
            ) : lastSyncedAt ? (
              <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />Last synced {new Date(lastSyncedAt).toLocaleString()} · {rows.length.toLocaleString()} items</>
            ) : (
              <>Never synced</>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => csvDownload(`e2g_report_${new Date().toISOString().slice(0,10)}.csv`, filtered)} disabled={!filtered.length}>
              <Download className="w-4 h-4 mr-2" /> Export CSV
            </Button>
            <Button onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              {syncing ? "Syncing P21…" : "Sync E2G report"}
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between mb-2 gap-2">
        <Input
          placeholder="Filter by item, description…"
          className="max-w-md"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(0); }}
        />
        <div className="text-sm text-muted-foreground">{filtered.length.toLocaleString()} rows</div>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {cols.map((c) => (
                <TableHead key={c.key} className={c.align === "right" ? "text-right" : ""}>
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label}
                    <ArrowUpDown className="w-3 h-3 opacity-50" />
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={cols.length} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
            )}
            {!isLoading && slice.length === 0 && (
              <TableRow><TableCell colSpan={cols.length} className="text-center text-muted-foreground py-8">
                No snapshot data yet — run a sync to populate.
              </TableCell></TableRow>
            )}
            {slice.map((r) => (
              <TableRow key={r.item_id}>
                <TableCell className="font-mono text-xs">{r.item_id}</TableCell>
                <TableCell className="max-w-[360px] truncate" title={r.item_desc ?? ""}>{r.item_desc ?? "—"}</TableCell>
                <TableCell className="text-right">{r.birm ?? "—"}</TableCell>
                <TableCell className="text-right">{r.dallas ?? "—"}</TableCell>
                <TableCell className="text-right">{r.ocala ?? "—"}</TableCell>
                <TableCell className="text-right font-medium">{r.total ?? "—"}</TableCell>
                <TableCell className="text-right">{r.e2g_price != null ? `$${Number(r.e2g_price).toFixed(2)}` : "—"}</TableCell>
                <TableCell className="text-right">{r.weight ?? "—"}</TableCell>
                <TableCell className="text-right">{r.net_weight ?? "—"}</TableCell>
                <TableCell className="text-xs whitespace-nowrap">{r.next_due_in_display ?? r.next_due_date ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <div className="flex justify-end gap-2 mt-2">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
        <span className="text-sm self-center">{page + 1} / {totalPages}</span>
        <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
      </div>
    </div>
  );
}
