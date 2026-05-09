import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Search, ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react";

export const Route = createFileRoute("/_app/inventory")({ component: InventoryPage });

const PAGE_SIZE = 50;
type SortKey = "item_id" | "item_desc" | "total_qty" | "e2g_price" | "birm_qty" | "dallas_qty" | "ocala_qty";

function InventoryPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "item_id", dir: "asc" });
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      // latest snapshot date only
      const { data: latest } = await supabase
        .from("inventory_snapshots")
        .select("snapshot_date")
        .order("snapshot_date", { ascending: false })
        .limit(1);
      const d = latest?.[0]?.snapshot_date;
      if (!d) { setRows([]); setLoading(false); return; }
      setSnapshotDate(d);
      const { data } = await supabase
        .from("inventory_snapshots")
        .select("*")
        .eq("snapshot_date", d)
        .order("item_id")
        .limit(10000);
      setRows(data ?? []);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter((r) => r.item_id?.toLowerCase().includes(q) || r.item_desc?.toLowerCase().includes(q));
    out = [...out].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, search, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); }, [search, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }
  function SortHead({ k, label }: { k: SortKey; label: string }) {
    return (
      <TableHead onClick={() => toggleSort(k)} className="cursor-pointer select-none">
        <span className="inline-flex items-center gap-1">{label}<ArrowUpDown className="w-3 h-3 opacity-50" /></span>
      </TableHead>
    );
  }

  return (
    <div>
      <ModuleHeader
        title="Inventory"
        description={snapshotDate ? `Latest snapshot · ${new Date(snapshotDate).toLocaleString()} · ${filtered.length.toLocaleString()} items` : "P21 inventory snapshot across Birmingham, Dallas, and Ocala"}
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
            {!loading && slice.length === 0 && (<TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No items.</TableCell></TableRow>)}
            {slice.map((r) => (
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
          <span className="text-xs text-muted-foreground">Page {page + 1} of {pages}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="w-4 h-4" /></Button>
            <Button size="sm" variant="outline" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
