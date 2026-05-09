import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Search, ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react";

export const Route = createFileRoute("/_app/pricing")({ component: PricingPage });

const PAGE_SIZE = 50;
type SortKey = "item" | "description" | "list_price" | "dealer_cost" | "er_cost" | "category";

function PricingPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "item", dir: "asc" });

  useEffect(() => {
    (async () => {
      setLoading(true);
      // PostgREST caps responses at 1000 rows; page through with .range().
      const all: any[] = [];
      const step = 1000;
      for (let from = 0; ; from += step) {
        const { data, error } = await supabase
          .from("price_list")
          .select("*")
          .order("item")
          .range(from, from + step - 1);
        if (error) break;
        all.push(...(data ?? []));
        if (!data || data.length < step) break;
      }
      setRows(all);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter((r) => r.item?.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q) || r.mfg?.toLowerCase().includes(q) || r.category?.toLowerCase().includes(q));
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
  function money(v: any) { return v == null || v === "" ? "—" : `$${Number(v).toFixed(2)}`; }

  return (
    <div>
      <ModuleHeader
        title="Price List"
        description={`Master pricing · ${filtered.length.toLocaleString()} items`}
        actions={
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search item, mfg, category…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        }
      />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead k="item" label="Item" />
              <SortHead k="description" label="Description" />
              <SortHead k="category" label="Category" />
              <TableHead>Mfg</TableHead>
              <SortHead k="list_price" label="List" />
              <SortHead k="dealer_cost" label="Dealer" />
              <SortHead k="er_cost" label="ER" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (<TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>)}
            {!loading && slice.length === 0 && (<TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No items.</TableCell></TableRow>)}
            {slice.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.item}</TableCell>
                <TableCell className="max-w-md truncate">{r.description ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.category ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.mfg ?? "—"}</TableCell>
                <TableCell>{money(r.list_price)}</TableCell>
                <TableCell>{money(r.dealer_cost)}</TableCell>
                <TableCell className="font-semibold">{money(r.er_cost)}</TableCell>
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
