import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { FileText, Download, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/catalogs")({ component: CatalogsPage });

function CatalogsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("catalogs").select("*").order("published_date", { ascending: false });
    setItems(data ?? []);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const ch = supabase.channel("catalogs").on("postgres_changes", { event: "*", schema: "public", table: "catalogs" }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

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

  return (
    <div>
      <ModuleHeader title="Catalogs" description="Product and clearance catalogs. Parsed SKUs are used to verify incoming purchase orders." />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.length === 0 && <p className="text-sm text-muted-foreground">No catalogs yet.</p>}
        {items.map((c) => {
          const url = urlFor(c.file_path);
          const status = c.parse_status ?? "pending";
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
