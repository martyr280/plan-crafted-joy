import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Search, ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react";

export const Route = createFileRoute("/_app/inventory")({ component: InventoryPage });

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200, 500];
type SortKey = "item_id" | "item_desc" | "total_qty" | "e2g_price" | "birm_qty" | "dallas_qty" | "ocala_qty";

function InventoryPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "item_id", dir: "asc" });
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null);

  // Resolve the latest snapshot date once.
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("inventory_snapshots")
        .select("snapshot_date")
        .order("snapshot_date", { ascending: false })
        .limit(1);
      setSnapshotDate(data?.[0]?.snapshot_date ?? null);
    })();
  }, []);

  // Debounce typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 0 when filters change.
  useEffect(() => { setPage(0); }, [debouncedSearch, sort, snapshotDate]);

  // Server-side page fetch (only the visible window crosses the wire).
  useEffect(() => {
    if (!snapshotDate) { setRows([]); setTotal(0); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const from = page * pageSize;
      const to = from + pageSize - 1;
      let q = supabase
        .from("inventory_snapshots")
        .select("*", { count: "exact" })
        .eq("snapshot_date", snapshotDate)
        .order(sort.key, { ascending: sort.dir === "asc", nullsFirst: false })
        .range(from, to);
      if (debouncedSearch) {
        const esc = debouncedSearch.replace(/[%,()]/g, " ");
        q = q.or(`item_id.ilike.%${esc}%,item_desc.ilike.%${esc}%`);
      }
      const { data, count, error } = await q;
      if (cancelled) return;
      if (!error) {
        setRows(data ?? []);
        setTotal(count ?? 0);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [page, sort, debouncedSearch, snapshotDate]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(total, (page + 1) * pageSize);

  function toggleSort(key: SortKey) {
    setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function SortHead({ k, label }: { k: SortKey; label: string }) {
    const active = sort.key === k;
    return (
      <TableHead onClick={() => toggleSort(k)} className="cursor-pointer select-none">
        <span className={`inline-flex items-center gap-1 ${active ? "text-foreground" : ""}`}>{label}<ArrowUpDown className={`w-3 h-3 ${active ? "opacity-100" : "opacity-50"}`} /></span>
      </TableHead>
    );
  }

  return (
    <div>
      <ModuleHeader
        title="Inventory"
        description={snapshotDate ? `Latest snapshot · ${new Date(snapshotDate).toLocaleString()} · ${total.toLocaleString()} items` : "P21 inventory snapshot across Birmingham, Dallas, and Ocala"}
        actions={
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search item or description…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        }
      />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead k="item_id" label="Item" />
              <SortHead k="item_desc" label="Description" />
              <SortHead k="birm_qty" label="Birm" />
              <SortHead k="dallas_qty" label="Dallas" />
              <SortHead k="ocala_qty" label="Ocala" />
              <SortHead k="total_qty" label="Total" />
              <SortHead k="e2g_price" label="E2G Price" />
              <TableHead>Wt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (<TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>)}
            {!loading && rows.length === 0 && (<TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No items.</TableCell></TableRow>)}
            {!loading && rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.item_id}{r.is_kit && <Badge variant="outline" className="ml-2 text-[10px]">kit</Badge>}</TableCell>
                <TableCell className="max-w-md truncate">{r.item_desc}</TableCell>
                <TableCell className={r.birm_qty > 0 ? "" : "text-muted-foreground"}>{r.is_kit ? "—" : r.birm_qty}</TableCell>
                <TableCell className={r.dallas_qty > 0 ? "" : "text-muted-foreground"}>{r.is_kit ? "—" : r.dallas_qty}</TableCell>
                <TableCell className={r.ocala_qty > 0 ? "" : "text-muted-foreground"}>{r.is_kit ? "—" : r.ocala_qty}</TableCell>
                <TableCell className="font-semibold">{r.total_qty}</TableCell>
                <TableCell>{r.e2g_price != null ? `$${Number(r.e2g_price).toFixed(2)}` : "—"}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{r.weight ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between p-3 border-t">
          <span className="text-xs text-muted-foreground">{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()} · Page {page + 1} of {pages}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft className="w-4 h-4" /></Button>
            <Button size="sm" variant="outline" disabled={page >= pages - 1 || loading} onClick={() => setPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
