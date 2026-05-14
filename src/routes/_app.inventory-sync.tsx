import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { RefreshCw, ExternalLink, Download, Loader2, Database, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { syncE2GReport, applyE2GToPricer } from "@/lib/p21.functions";

export const Route = createFileRoute("/_app/inventory-sync")({ component: InventorySyncPage });

const PAGE_SIZE = 50;

function normSku(s: string | null | undefined) {
  return String(s || "").toUpperCase().replace(/\s+/g, "").replace(/[.,;]+$/, "").trim();
}

function jaccard(a: string, b: string) {
  const ta = new Set(String(a || "").toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(String(b || "").toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
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

function InventorySyncPage() {
  const [website, setWebsite] = useState<any[]>([]);
  const [pricer, setPricer] = useState<any[]>([]);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [e2gAll, setE2gAll] = useState<any[]>([]);
  const [crawls, setCrawls] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [e2gSyncing, setE2gSyncing] = useState(false);
  const [e2gLast, setE2gLast] = useState<{ syncedAt: string | null; count: number }>({ syncedAt: null, count: 0 });
  const [e2gError, setE2gError] = useState<string | null>(null);
  const [e2gPreview, setE2gPreview] = useState<any[]>([]);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const runSyncE2G = useServerFn(syncE2GReport);
  const runApplyE2G = useServerFn(applyE2GToPricer);

  async function loadE2GStatus() {
    const [{ data: latest }, { count }, { data: preview }] = await Promise.all([
      supabase.from("e2g_inventory_snapshot").select("synced_at").order("synced_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("e2g_inventory_snapshot").select("id", { count: "exact", head: true }),
      supabase.from("e2g_inventory_snapshot")
        .select("item_id, item_desc, birm, dallas, ocala, total, e2g_price, next_due_date, next_due_in_display, synced_at")
        .order("synced_at", { ascending: false })
        .order("item_id", { ascending: true })
        .limit(25),
    ]);
    setE2gLast({ syncedAt: (latest as any)?.synced_at ?? null, count: count ?? 0 });
    setE2gPreview(preview ?? []);
  }

  async function handleSyncE2G() {
    setE2gSyncing(true);
    setE2gError(null);
    try {
      const res = await runSyncE2G();
      toast.success(`E2G sync complete — imported ${res.imported.toLocaleString()} items`);
      await loadE2GStatus();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setE2gError(msg);
      toast.error(`E2G sync failed: ${msg}`);
    } finally {
      setE2gSyncing(false);
    }
  }


  async function loadAll() {
    setLoading(true);
    // Fetch ALL rows with explicit pagination; never trust default 1000.
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
      const [w, p, c, e, cr] = await Promise.all([
        fetchAll("website_items", "sku, name, description, image_url, detail_url, brand, in_stock, stock_text, crawled_at"),
        fetchAll("price_list", "id, item, description, list_price, weight, mfg, category, e2g_price, e2g_weight, in_e2g, e2g_synced_at"),
        fetchAll("catalog_items", "sku, description, list_price, page, mfg"),
        fetchAll("e2g_inventory_snapshot", "item_id, item_desc, e2g_price, weight, total"),
        supabase.from("website_crawls").select("*").order("started_at", { ascending: false }).limit(10).then((r) => r.data ?? []),
      ]);
      setWebsite(w); setPricer(p); setCatalog(c); setE2gAll(e); setCrawls(cr);
    } catch (e: any) {
      toast.error(`Load failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); loadE2GStatus(); }, []);
  useEffect(() => {
    const ch = supabase.channel("website_crawls-live").on("postgres_changes", { event: "*", schema: "public", table: "website_crawls" }, () => loadAll()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const { missingFromPricer, missingFromWebsite, mismatches } = useMemo(() => {
    const pricerMap = new Map<string, any>();
    for (const r of pricer) pricerMap.set(normSku(r.item), r);
    const catalogMap = new Map<string, any>();
    for (const r of catalog) catalogMap.set(normSku(r.sku), r);
    const websiteMap = new Map<string, any>();
    for (const r of website) websiteMap.set(normSku(r.sku), r);

    const missingPricer: any[] = [];
    const mism: any[] = [];
    for (const w of website) {
      const k = normSku(w.sku);
      const p = pricerMap.get(k);
      const c = catalogMap.get(k);
      if (!p && !c) {
        missingPricer.push({ sku: w.sku, name: w.name, description: w.description, brand: w.brand, detail_url: w.detail_url });
      } else {
        const refDesc = p?.description || c?.description || "";
        if (refDesc && w.description && jaccard(refDesc, w.description) < 0.3) {
          mism.push({
            sku: w.sku,
            website_desc: w.description,
            pricer_desc: p?.description ?? null,
            catalog_desc: c?.description ?? null,
            detail_url: w.detail_url,
          });
        }
      }
    }
    const missingWeb: any[] = [];
    for (const p of pricer) {
      const k = normSku(p.item);
      if (!websiteMap.has(k)) {
        missingWeb.push({ sku: p.item, description: p.description, mfg: p.mfg, list_price: p.list_price, source: "pricer" });
      }
    }
    for (const c of catalog) {
      const k = normSku(c.sku);
      if (!websiteMap.has(k) && !pricerMap.has(k)) {
        missingWeb.push({ sku: c.sku, description: c.description, mfg: c.mfg, list_price: c.list_price, source: "catalog" });
      }
    }
    return { missingFromPricer: missingPricer, missingFromWebsite: missingWeb, mismatches: mism };
  }, [website, pricer, catalog]);

  const pricerVsE2G = useMemo(() => {
    const pricerMap = new Map<string, any>();
    for (const r of pricer) pricerMap.set(normSku(r.item), r);
    const e2gMap = new Map<string, any>();
    for (const r of e2gAll) e2gMap.set(normSku(r.item_id), r);

    const out: any[] = [];
    const numEq = (a: any, b: any) => {
      const na = a == null ? null : Number(a);
      const nb = b == null ? null : Number(b);
      if (na == null && nb == null) return true;
      if (na == null || nb == null) return false;
      return Math.abs(na - nb) < 0.005;
    };

    for (const [k, e] of e2gMap) {
      const p = pricerMap.get(k);
      if (!p) {
        out.push({
          sku: e.item_id, status: "missing_in_pricer",
          pricer_desc: null, e2g_desc: e.item_desc,
          list_price: null, e2g_price: e.e2g_price,
          pricer_weight: null, e2g_weight: e.weight,
        });
      } else {
        const descDiff = (p.description ?? "").trim() !== (e.item_desc ?? "").trim();
        const priceDiff = !numEq(p.e2g_price, e.e2g_price);
        const weightDiff = !numEq(p.e2g_weight ?? p.weight, e.weight);
        let status = "match";
        if (descDiff && (priceDiff || weightDiff)) status = "multi_diff";
        else if (descDiff) status = "desc_diff";
        else if (priceDiff) status = "price_diff";
        else if (weightDiff) status = "weight_diff";
        out.push({
          sku: p.item, status,
          pricer_desc: p.description, e2g_desc: e.item_desc,
          list_price: p.list_price, e2g_price: e.e2g_price,
          pricer_weight: p.e2g_weight ?? p.weight, e2g_weight: e.weight,
        });
      }
    }
    for (const [k, p] of pricerMap) {
      if (!e2gMap.has(k)) {
        out.push({
          sku: p.item, status: "missing_in_e2g",
          pricer_desc: p.description, e2g_desc: null,
          list_price: p.list_price, e2g_price: null,
          pricer_weight: p.e2g_weight ?? p.weight, e2g_weight: null,
        });
      }
    }
    return out;
  }, [pricer, e2gAll]);

  const pricerVsE2GStats = useMemo(() => {
    const s = { match: 0, diff: 0, missing_in_pricer: 0, missing_in_e2g: 0 };
    for (const r of pricerVsE2G) {
      if (r.status === "match") s.match++;
      else if (r.status === "missing_in_pricer") s.missing_in_pricer++;
      else if (r.status === "missing_in_e2g") s.missing_in_e2g++;
      else s.diff++;
    }
    return s;
  }, [pricerVsE2G]);

  async function handleApplyE2G() {
    setApplying(true);
    setConfirmApply(false);
    try {
      const res = await runApplyE2G();
      toast.success(`Applied E2G: ${res.updated} updated · ${res.inserted} added · ${res.flaggedMissing} flagged missing`);
      await loadAll();
    } catch (e: any) {
      toast.error(`Apply failed: ${e?.message ?? e}`);
    } finally {
      setApplying(false);
    }
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

  function FilteredTable({ rows, columns }: { rows: any[]; columns: { key: string; label: string }[] }) {
    const filtered = filter
      ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(filter.toLowerCase()))
      : rows;
    const start = page * PAGE_SIZE;
    const slice = filtered.slice(start, start + PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    return (
      <>
        <div className="flex items-center justify-between mb-2">
          <Input placeholder="Filter…" className="max-w-xs" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} />
          <div className="flex gap-2 items-center text-sm text-muted-foreground">
            <span>{filtered.length.toLocaleString()} rows</span>
            <Button size="sm" variant="outline" onClick={() => csvDownload("inventory-sync.csv", filtered)} disabled={!filtered.length}>
              <Download className="w-4 h-4 mr-1" /> CSV
            </Button>
          </div>
        </div>
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}
                <TableHead>Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slice.map((r, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className="max-w-[320px] truncate" title={String(r[c.key] ?? "")}>
                      {String(r[c.key] ?? "—")}
                    </TableCell>
                  ))}
                  <TableCell>
                    {r.detail_url ? (
                      <a href={r.detail_url} target="_blank" rel="noreferrer" className="inline-flex items-center text-primary hover:underline">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    ) : (
                      <a href={`https://www.ndiof.com/itemdetail/${encodeURIComponent(r.sku)}`} target="_blank" rel="noreferrer" className="inline-flex items-center text-primary hover:underline">
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {slice.length === 0 && (
                <TableRow><TableCell colSpan={columns.length + 1} className="text-center text-muted-foreground py-6">No rows</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
        <div className="flex justify-end gap-2 mt-2">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
          <span className="text-sm self-center">{page + 1} / {totalPages}</span>
          <Button size="sm" variant="outline" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </>
    );
  }

  return (
    <div>
      <ModuleHeader
        title="Inventory Sync"
        description="Reconcile ndiof.com against the pricer XLSX and parsed catalogs. Crawls the website with Firecrawl."
      />

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
              <Database className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="font-semibold">E2G Combined Report (P21)</div>
              <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                {e2gError ? (
                  <><AlertCircle className="w-3.5 h-3.5 text-destructive" /><span className="text-destructive">{e2gError}</span></>
                ) : e2gLast.syncedAt ? (
                  <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />Last synced {new Date(e2gLast.syncedAt).toLocaleString()} · {e2gLast.count.toLocaleString()} items</>
                ) : (
                  <>Never synced</>
                )}
              </div>
            </div>
          </div>
          <Button onClick={handleSyncE2G} disabled={e2gSyncing}>
            {e2gSyncing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            {e2gSyncing ? "Syncing P21…" : "Sync E2G report"}
          </Button>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-semibold text-sm">Snapshot preview</div>
            <div className="text-xs text-muted-foreground">
              {e2gPreview.length
                ? `Showing ${e2gPreview.length} of ${e2gLast.count.toLocaleString()} rows from e2g_inventory_snapshot`
                : "No snapshot data yet — run a sync to populate."}
            </div>
          </div>
          {e2gPreview.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => csvDownload("e2g_snapshot_preview.csv", e2gPreview)}>
              <Download className="w-4 h-4 mr-1" /> CSV
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Birm</TableHead>
                <TableHead className="text-right">Dallas</TableHead>
                <TableHead className="text-right">Ocala</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">E2G Price</TableHead>
                <TableHead>Next Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {e2gPreview.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{r.item_id}</TableCell>
                  <TableCell className="max-w-[320px] truncate" title={r.item_desc ?? ""}>{r.item_desc ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.birm ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.dallas ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.ocala ?? "—"}</TableCell>
                  <TableCell className="text-right font-medium">{r.total ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.e2g_price != null ? `$${Number(r.e2g_price).toFixed(2)}` : "—"}</TableCell>
                  <TableCell className="text-xs">{r.next_due_in_display ?? r.next_due_date ?? "—"}</TableCell>
                </TableRow>
              ))}
              {e2gPreview.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">No rows</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap gap-6 items-center justify-between">
          <div className="flex flex-wrap gap-6 text-sm">
            <Stat label="Website SKUs" value={website.length} />
            <Stat label="Pricer SKUs" value={pricer.length} />
            <Stat label="Catalog SKUs" value={catalog.length} />
            <Stat label="Missing pricing" value={missingFromPricer.length} variant="warn" />
            <Stat label="Missing on web" value={missingFromWebsite.length} variant="warn" />
            <Stat label="Description mismatch" value={mismatches.length} variant="warn" />
          </div>
          <div className="flex items-center gap-3">
            {activeCrawl && (
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Crawling… {activeCrawl.skus_found} SKUs from {activeCrawl.pages_crawled} pages
              </div>
            )}
            {lastCrawl && !activeCrawl && (
              <div className="text-xs text-muted-foreground">
                Last crawl: {new Date(lastCrawl.completed_at).toLocaleString()}
              </div>
            )}
            <Button onClick={startCrawl} disabled={busy || !!activeCrawl}>
              <RefreshCw className="w-4 h-4 mr-2" />
              {activeCrawl ? "Crawl running…" : "Run full crawl"}
            </Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <Tabs defaultValue="missing-pricer" onValueChange={() => { setPage(0); setFilter(""); }}>
          <TabsList>
            <TabsTrigger value="missing-pricer">
              On website, no pricing <Badge variant="secondary" className="ml-2">{missingFromPricer.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="missing-web">
              In pricer/catalog, not on website <Badge variant="secondary" className="ml-2">{missingFromWebsite.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="mismatch">
              Description mismatch <Badge variant="secondary" className="ml-2">{mismatches.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="pricer-vs-e2g">
              Pricer vs E2G <Badge variant="secondary" className="ml-2">{pricerVsE2GStats.diff + pricerVsE2GStats.missing_in_pricer}</Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="missing-pricer" className="mt-4">
            <FilteredTable rows={missingFromPricer} columns={[
              { key: "sku", label: "SKU" },
              { key: "name", label: "Name" },
              { key: "brand", label: "Brand" },
              { key: "description", label: "Website description" },
            ]} />
          </TabsContent>
          <TabsContent value="missing-web" className="mt-4">
            <FilteredTable rows={missingFromWebsite} columns={[
              { key: "sku", label: "SKU" },
              { key: "description", label: "Description" },
              { key: "mfg", label: "Mfg" },
              { key: "list_price", label: "List price" },
              { key: "source", label: "Source" },
            ]} />
          </TabsContent>
          <TabsContent value="mismatch" className="mt-4">
            <FilteredTable rows={mismatches} columns={[
              { key: "sku", label: "SKU" },
              { key: "website_desc", label: "Website" },
              { key: "pricer_desc", label: "Pricer" },
              { key: "catalog_desc", label: "Catalog" },
            ]} />
          </TabsContent>
          <TabsContent value="pricer-vs-e2g" className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div className="flex gap-5 text-sm">
                <Stat label="Match" value={pricerVsE2GStats.match} />
                <Stat label="Differ" value={pricerVsE2GStats.diff} variant="warn" />
                <Stat label="E2G-only" value={pricerVsE2GStats.missing_in_pricer} variant="warn" />
                <Stat label="Pricer-only" value={pricerVsE2GStats.missing_in_e2g} variant="warn" />
              </div>
              <div className="flex items-center gap-2">
                {confirmApply ? (
                  <>
                    <span className="text-xs text-muted-foreground">Overwrite pricer description/weight and store E2G price?</span>
                    <Button size="sm" variant="outline" onClick={() => setConfirmApply(false)} disabled={applying}>Cancel</Button>
                    <Button size="sm" onClick={handleApplyE2G} disabled={applying}>
                      {applying ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                      Confirm
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={() => setConfirmApply(true)} disabled={applying || e2gAll.length === 0}>
                    <Database className="w-4 h-4 mr-1" /> Apply E2G values to pricer
                  </Button>
                )}
              </div>
            </div>
            <FilteredTable rows={pricerVsE2G} columns={[
              { key: "sku", label: "SKU" },
              { key: "status", label: "Status" },
              { key: "pricer_desc", label: "Pricer desc" },
              { key: "e2g_desc", label: "E2G desc" },
              { key: "list_price", label: "List price" },
              { key: "e2g_price", label: "E2G price" },
              { key: "pricer_weight", label: "Pricer wt" },
              { key: "e2g_weight", label: "E2G wt" },
            ]} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Stat({ label, value, variant }: { label: string; value: number; variant?: "warn" }) {
  return (
    <div>
      <div className={`text-xl font-semibold ${variant === "warn" && value > 0 ? "text-destructive" : ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
