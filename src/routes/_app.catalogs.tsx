import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { FileText, Download, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/catalogs")({ component: CatalogsPage });

const PAGES_PER_CHUNK = 8; // must match ingest-catalog edge function

function CatalogsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // catalog_id -> highest page extracted so far
  const [progress, setProgress] = useState<Record<string, number>>({});

  async function load() {
    const { data } = await supabase.from("catalogs").select("*").order("published_date", { ascending: false });
    setItems(data ?? []);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const ch = supabase.channel("catalogs").on("postgres_changes", { event: "*", schema: "public", table: "catalogs" }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Fetch max(page) per catalog — refresh every 3s while any catalog is parsing.
  useEffect(() => {
    let cancelled = false;
    async function fetchProgress() {
      const ids = items.map((c) => c.id);
      if (!ids.length) return;
      const next: Record<string, number> = {};
      // One round-trip per catalog (small N — typically a handful of catalogs).
      await Promise.all(
        ids.map(async (id) => {
          const { data } = await supabase
            .from("catalog_items")
            .select("page")
            .eq("catalog_id", id)
            .order("page", { ascending: false })
            .limit(1)
            .maybeSingle();
          next[id] = Number(data?.page ?? 0);
        }),
      );
      if (!cancelled) setProgress(next);
    }
    fetchProgress();
    const anyParsing = items.some((c) => c.parse_status === "parsing");
    if (!anyParsing) return () => { cancelled = true; };
    const t = setInterval(fetchProgress, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [items]);

  async function reparse(c: any) {
    setBusy(c.id);
    const { error } = await supabase.functions.invoke("ingest-catalog", { body: { catalog_id: c.id } });
    setBusy(null);
    if (error) toast.error(`Parse failed: ${error.message}`);
    else toast.success(`Parsing "${c.name}" — this runs in the background.`);
    load();
  }

  function urlFor(p: string) {
    return supabase.storage.from("catalogs").getPublicUrl(p).data.publicUrl;
  }
  function size(b: number | null) {
    if (!b) return "";
    const mb = b / 1024 / 1024;
    return `${mb.toFixed(1)} MB`;
  }
  function statusVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
    if (s === "ready") return "default";
    if (s === "parsing") return "secondary";
    if (s === "error") return "destructive";
    return "outline";
  }

  function progressFor(c: any) {
    const totalPages = Number(c.pages ?? 0);
    if (!totalPages) return null;
    const status = c.parse_status ?? "pending";
    // When ready, show full progress. Otherwise derive from max page extracted, rounded up to chunk boundary.
    const maxPage = Number(progress[c.id] ?? 0);
    const pagesProcessed =
      status === "ready"
        ? totalPages
        : Math.min(totalPages, Math.ceil(maxPage / PAGES_PER_CHUNK) * PAGES_PER_CHUNK);
    const totalChunks = Math.ceil(totalPages / PAGES_PER_CHUNK);
    const chunksDone =
      status === "ready" ? totalChunks : Math.ceil(pagesProcessed / PAGES_PER_CHUNK);
    const pct = totalPages ? Math.min(100, Math.round((pagesProcessed / totalPages) * 100)) : 0;
    return { pagesProcessed, totalPages, chunksDone, totalChunks, pct };
  }

  return (
    <div>
      <ModuleHeader title="Catalogs" description="Product and clearance catalogs. Parsed SKUs are used to verify incoming purchase orders." />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.length === 0 && <p className="text-sm text-muted-foreground">No catalogs yet.</p>}
        {items.map((c) => {
          const url = urlFor(c.file_path);
          const status = c.parse_status ?? "pending";
          const prog = progressFor(c);
          const showProgress = prog && (status === "parsing" || status === "ready");
          return (
            <Card key={c.id} className="p-4 flex flex-col gap-3">
              <div className="aspect-[3/4] bg-muted rounded-md flex items-center justify-center">
                <FileText className="w-12 h-12 text-muted-foreground" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">{c.name}</h3>
                <div className="mt-1 flex gap-2 flex-wrap text-xs items-center">
                  <Badge variant="outline">{c.kind}</Badge>
                  {c.published_date && <Badge variant="outline">{c.published_date}</Badge>}
                  <Badge variant={statusVariant(status)}>{status}{status === "ready" && c.sku_count ? ` · ${c.sku_count} SKUs` : ""}</Badge>
                  {c.size_bytes && <span className="text-muted-foreground">{size(c.size_bytes)}</span>}
                </div>
                {c.parse_error && <p className="text-xs text-destructive mt-1 truncate" title={c.parse_error}>{c.parse_error}</p>}
              </div>
              {showProgress && prog && (
                <div className="space-y-1">
                  <Progress value={prog.pct} className="h-2" />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {prog.pagesProcessed}/{prog.totalPages} pages · chunk {prog.chunksDone}/{prog.totalChunks}
                    </span>
                    <span>
                      {prog.pct}%{c.sku_count ? ` · ${c.sku_count} SKUs` : ""}
                    </span>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button asChild size="sm" variant="outline" className="flex-1">
                  <a href={url} target="_blank" rel="noreferrer"><ExternalLink className="w-4 h-4 mr-2" />View</a>
                </Button>
                <Button asChild size="sm" variant="outline" className="flex-1">
                  <a href={url} download><Download className="w-4 h-4 mr-2" />Download</a>
                </Button>
              </div>
              <Button size="sm" onClick={() => reparse(c)} disabled={busy === c.id || status === "parsing"}>
                <RefreshCw className={`w-4 h-4 mr-2 ${status === "parsing" ? "animate-spin" : ""}`} />
                {status === "ready" ? "Re-parse" : status === "parsing" ? "Parsing…" : "Parse PDF"}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
