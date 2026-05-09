import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Search, ChevronLeft, ChevronRight, ArrowUpDown } from "lucide-react";

export const Route = createFileRoute("/_app/pricing")({ component: PricingPage });

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200, 500];
type SortKey = "item" | "description" | "list_price" | "dealer_cost" | "er_cost" | "category";

function PricingPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "item", dir: "asc" });

  // Debounce the search input so we don't fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to first page whenever filters or sort change.
  useEffect(() => { setPage(0); }, [debouncedSearch, sort]);

  // Server-side page fetch — only the visible window crosses the wire,
  // so the 1000-row PostgREST cap is irrelevant.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let q = supabase
        .from("price_list")
        .select("*", { count: "exact" })
        .order(sort.key, { ascending: sort.dir === "asc", nullsFirst: false })
        .range(from, to);
      if (debouncedSearch) {
        const esc = debouncedSearch.replace(/[%,()]/g, " ");
        q = q.or(`item.ilike.%${esc}%,description.ilike.%${esc}%,mfg.ilike.%${esc}%,category.ilike.%${esc}%`);
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
  }, [page, sort, debouncedSearch]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

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
  function money(v: any) { return v == null || v === "" ? "—" : `$${Number(v).toFixed(2)}`; }

  return (
    <div>
      <ModuleHeader
        title="Price List"
        description={`Master pricing · ${total.toLocaleString()} items`}
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
            {!loading && rows.length === 0 && (<TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No items.</TableCell></TableRow>)}
            {!loading && rows.map((r) => (
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
