import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { RefreshCw, ExternalLink, Download, Loader2, ArrowUpDown, AlertTriangle, ImageOff, FileText, Clock } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/inventory-sync")({ component: InventorySyncPage });

const PAGE_SIZE = 50;
const STALE_DAYS = 30;
const SHORT_DESC = 20;

// Categories we treat as not-for-web until a real flag exists in price_list.
// Empty for now — we'll tune after first run with the user.
const WEB_BLOCKLIST_CATEGORIES = new Set<string>([]);

function normSku(s: string | null | undefined) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[.,;]+$/, "").trim();
}

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

function isWebSellable(category: string | null | undefined): boolean {
  if (!category) return true;
  return !WEB_BLOCKLIST_CATEGORIES.has(category.trim());
}

type SortDir = "asc" | "desc";

function InventorySyncPage() {
  const [website, setWebsite] = useState<any[]>([]);
  const [pricer, setPricer] = useState<any[]>([]);
  const [crawls, setCrawls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"add" | "price" | "stock">("add");
  const [onlySellable, setOnlySellable] = useState(true);
  const [mfg, setMfg] = useState<string>("__all__");
  const [sortKey, setSortKey] = useState<string>("list_price");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  async function loadAll() {
    setLoading(true);
    const fetchAll = async (table: string, cols: string) => {
      const out: any[] = [];
      const step = 1000;
      for (let from = 0; ; from += step) {
        const { data, error } = await supabase.from(table as any).select(cols).range(from, from + step - 1);
        if (error) throw error;
        out.push(...(data ?? []));
        if (!data || data.length < step) break;
      }
      return out;
    };
    try {
      const [w, p, cr] = await Promise.all([
        fetchAll("website_items", "sku, name, description, image_url, detail_url, brand, in_stock, stock_text, crawled_at"),
        fetchAll("price_list", "id, item, description, list_price, weight, mfg, category"),
        supabase.from("website_crawls").select("*").order("started_at", { ascending: false }).limit(10).then((r) => r.data ?? []),
      ]);
      setWebsite(w); setPricer(p); setCrawls(cr);
    } catch (e: any) {
      toast.error(`Load failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, []);
  useEffect(() => {
    const ch = supabase.channel("website_crawls-live").on("postgres_changes", { event: "*", schema: "public", table: "website_crawls" }, () => loadAll()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  useEffect(() => { setPage(0); }, [tab, filter, onlySellable, mfg, sortKey, sortDir]);

  // Build add-to-website and stock-content lists from pricer + website
  const { addRows, stockRows, mfgOptions } = useMemo(() => {
    const websiteMap = new Map<string, any>();
    for (const w of website) websiteMap.set(normSku(w.sku), w);
    const mfgs = new Set<string>();

    const add: any[] = [];
    for (const p of pricer) {
      if (p.mfg) mfgs.add(p.mfg);
      const k = normSku(p.item);
      if (websiteMap.has(k)) continue;
      add.push({
        sku: p.item,
        description: p.description ?? "",
        mfg: p.mfg ?? null,
        category: p.category ?? null,
        list_price: p.list_price ?? null,
        sellable: isWebSellable(p.category),
      });
    }

    const pricerMap = new Map<string, any>();
    for (const r of pricer) pricerMap.set(normSku(r.item), r);

    const now = Date.now();
    const stock: any[] = [];
    for (const w of website) {
      const issues: string[] = [];
      const oos = w.in_stock === false;
      const noImg = !w.image_url;
      const shortDesc = !w.description || String(w.description).trim().length < SHORT_DESC;
      const stale = w.crawled_at && (now - new Date(w.crawled_at).getTime()) > STALE_DAYS * 86400000;
      if (oos) issues.push("oos");
      if (noImg) issues.push("noimg");
      if (shortDesc) issues.push("shortdesc");
      if (stale) issues.push("stale");
      if (!issues.length) continue;
      const p = pricerMap.get(normSku(w.sku));
      stock.push({
        sku: w.sku,
        description: w.description ?? "",
        mfg: p?.mfg ?? w.brand ?? null,
        category: p?.category ?? null,
        list_price: p?.list_price ?? null,
        detail_url: w.detail_url,
        image_url: w.image_url,
        in_stock: w.in_stock,
        crawled_at: w.crawled_at,
        issues,
      });
    }

    return {
      addRows: add,
      stockRows: stock,
      mfgOptions: Array.from(mfgs).filter(Boolean).sort(),
    };
  }, [pricer, website]);

  const activeRows = useMemo(() => {
    let rows = tab === "add" ? addRows : tab === "stock" ? stockRows : [];
    if (tab === "add" && onlySellable) rows = rows.filter((r) => r.sellable);
    if (mfg !== "__all__") rows = rows.filter((r) => (r.mfg ?? "") === mfg);
    if (filter) {
      const q = filter.toLowerCase();
      rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    }
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [tab, addRows, stockRows, onlySellable, mfg, filter, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(activeRows.length / PAGE_SIZE));
  const slice = activeRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  async function startCrawl() {
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.functions.invoke("crawl-website", { body: { user_id: user?.id } });
    setBusy(false);
    if (error) toast.error(`Crawl failed to start: ${error.message}`);
    else toast.success("Crawl started — this can take 10–30 minutes.");
    loadAll();
  }

  const activeCrawl = crawls.find((c) => c.status === "running");
  const lastCrawl = crawls.find((c) => c.status === "completed");

  // KPI counts
  const sellableAdd = addRows.filter((r) => r.sellable);
  const oosCount = stockRows.filter((r) => r.issues.includes("oos")).length;
  const contentCount = stockRows.filter((r) => r.issues.includes("noimg") || r.issues.includes("shortdesc")).length;

  return (
    <div>
      <ModuleHeader
        title="Inventory Sync"
        description="Find products worth adding to ndiof.com and listings that need attention. Ranked by list price until per-SKU sales rollup is wired up."
        actions={
          <Button onClick={startCrawl} disabled={busy || !!activeCrawl} size="sm">
            <RefreshCw className="w-4 h-4 mr-2" />
            {activeCrawl ? "Crawl running…" : "Run full crawl"}
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <KpiCard
          label="Missing from website"
          value={sellableAdd.length}
          sub={`${addRows.length.toLocaleString()} total · ${sellableAdd.length.toLocaleString()} web-sellable`}
          accent="warn"
          onClick={() => setTab("add")}
        />
        <KpiCard
          label="Price review"
          value={0}
          sub="Needs website prices (not crawled yet)"
          accent="muted"
          onClick={() => setTab("price")}
        />
        <KpiCard
          label="Out of stock on web"
          value={oosCount}
          sub="Listed but unavailable"
          accent={oosCount > 0 ? "warn" : "muted"}
          onClick={() => setTab("stock")}
        />
        <KpiCard
          label="Content gaps"
          value={contentCount}
          sub="Missing image or thin description"
          accent={contentCount > 0 ? "warn" : "muted"}
          onClick={() => setTab("stock")}
        />
      </div>

      <Card className="p-3 mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span><strong className="text-foreground">{website.length.toLocaleString()}</strong> SKUs on ndiof.com</span>
          <span><strong className="text-foreground">{pricer.length.toLocaleString()}</strong> SKUs in pricer</span>
          {lastCrawl && !activeCrawl && (
            <span>Last crawl {new Date(lastCrawl.completed_at).toLocaleString()}</span>
          )}
          {activeCrawl && (
            <span className="flex items-center gap-1.5 text-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Crawling — {activeCrawl.skus_found} SKUs from {activeCrawl.pages_crawled} pages
            </span>
          )}
        </div>
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList>
            <TabsTrigger value="add">
              Add to website <Badge variant="secondary" className="ml-2">{sellableAdd.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="price">
              Price review <Badge variant="secondary" className="ml-2">0</Badge>
            </TabsTrigger>
            <TabsTrigger value="stock">
              Stock & content <Badge variant="secondary" className="ml-2">{stockRows.length}</Badge>
            </TabsTrigger>
          </TabsList>

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2 mt-4 mb-2">
            <Input
              placeholder="Search SKU, description, brand…"
              className="max-w-xs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Select value={mfg} onValueChange={setMfg}>
              <SelectTrigger className="w-[200px]"><SelectValue placeholder="Manufacturer" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All manufacturers</SelectItem>
                {mfgOptions.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            {tab === "add" && (
              <label className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={onlySellable} onChange={(e) => setOnlySellable(e.target.checked)} />
                Only web-sellable
              </label>
            )}
            <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
              <span>{activeRows.length.toLocaleString()} rows</span>
              <Button size="sm" variant="outline" onClick={() => csvDownload(`inventory-sync-${tab}.csv`, activeRows)} disabled={!activeRows.length}>
                <Download className="w-4 h-4 mr-1" /> CSV
              </Button>
            </div>
          </div>

          <TabsContent value="add" className="mt-0">
            <AddTable rows={slice} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          </TabsContent>
          <TabsContent value="price" className="mt-0">
            <Card className="p-6 text-sm text-muted-foreground">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-500 shrink-0" />
                <div>
                  <p className="text-foreground font-medium mb-1">Price comparison not available yet</p>
                  <p>The current website crawler doesn't capture prices from product pages. Once the crawler is extended to pull list prices, this tab will surface SKUs where the website price disagrees with the pricer by more than $1 or 2%, ranked by sales velocity.</p>
                </div>
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="stock" className="mt-0">
            <StockTable rows={slice} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
          </TabsContent>

          {tab !== "price" && (
            <div className="flex justify-end items-center gap-2 mt-3">
              <span className="text-sm text-muted-foreground">
                {activeRows.length === 0 ? "—" : `${page * PAGE_SIZE + 1}–${Math.min(activeRows.length, (page + 1) * PAGE_SIZE)} of ${activeRows.length.toLocaleString()}`}
              </span>
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
              <span className="text-sm self-center">{page + 1} / {totalPages}</span>
              <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          )}
        </Tabs>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub, accent, onClick }: { label: string; value: number; sub: string; accent: "warn" | "muted"; onClick?: () => void }) {
  return (
    <Card
      onClick={onClick}
      className={`p-4 cursor-pointer hover:bg-accent/30 transition-colors ${accent === "warn" && value > 0 ? "border-amber-500/40" : ""}`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent === "warn" && value > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground mt-1 truncate">{sub}</div>
    </Card>
  );
}

function SortHead({ label, k, sortKey, sortDir, onSort, align }: { label: string; k: string; sortKey: string; sortDir: SortDir; onSort: (k: string) => void; align?: "right" }) {
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onSort(k)}>
        {label}
        <ArrowUpDown className={`w-3 h-3 ${sortKey === k ? "opacity-100" : "opacity-40"}`} />
        {sortKey === k && <span className="text-[10px]">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </TableHead>
  );
}

function AddTable({ rows, sortKey, sortDir, onSort }: { rows: any[]; sortKey: string; sortDir: SortDir; onSort: (k: string) => void }) {
  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead label="SKU" k="sku" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHead label="Description" k="description" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHead label="Mfg" k="mfg" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHead label="Category" k="category" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHead label="List price" k="list_price" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
            <TableHead>Link</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="font-mono text-xs">{r.sku}</TableCell>
              <TableCell className="max-w-[420px] truncate" title={r.description}>{r.description || "—"}</TableCell>
              <TableCell>{r.mfg ?? "—"}</TableCell>
              <TableCell className="text-xs">{r.category ?? "—"}</TableCell>
              <TableCell className="text-right">{r.list_price != null ? `$${Number(r.list_price).toFixed(2)}` : "—"}</TableCell>
              <TableCell>
                <a href={`https://www.ndiof.com/itemdetail/${encodeURIComponent(r.sku)}`} target="_blank" rel="noreferrer" className="inline-flex items-center text-primary hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No rows match the current filters.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}

function StockTable({ rows, sortKey, sortDir, onSort }: { rows: any[]; sortKey: string; sortDir: SortDir; onSort: (k: string) => void }) {
  return (
    <Card className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <SortHead label="SKU" k="sku" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHead label="Description" k="description" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <SortHead label="Mfg" k="mfg" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            <TableHead>Issues</TableHead>
            <SortHead label="List price" k="list_price" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
            <TableHead>Link</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="font-mono text-xs">{r.sku}</TableCell>
              <TableCell className="max-w-[360px] truncate" title={r.description}>{r.description || "—"}</TableCell>
              <TableCell>{r.mfg ?? "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {r.issues.includes("oos") && <Badge variant="destructive" className="gap-1"><AlertTriangle className="w-3 h-3" />Out of stock</Badge>}
                  {r.issues.includes("noimg") && <Badge variant="outline" className="gap-1"><ImageOff className="w-3 h-3" />No image</Badge>}
                  {r.issues.includes("shortdesc") && <Badge variant="outline" className="gap-1"><FileText className="w-3 h-3" />Thin desc</Badge>}
                  {r.issues.includes("stale") && <Badge variant="outline" className="gap-1"><Clock className="w-3 h-3" />Stale</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-right">{r.list_price != null ? `$${Number(r.list_price).toFixed(2)}` : "—"}</TableCell>
              <TableCell>
                {r.detail_url ? (
                  <a href={r.detail_url} target="_blank" rel="noreferrer" className="inline-flex items-center text-primary hover:underline">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : "—"}
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No listings have issues. Nice.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
