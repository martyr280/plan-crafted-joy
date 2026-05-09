import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { FileText, Download, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/_app/catalogs")({ component: CatalogsPage });

function CatalogsPage() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("catalogs").select("*").order("published_date", { ascending: false });
      setItems(data ?? []);
    })();
  }, []);

  function urlFor(p: string) {
    return supabase.storage.from("catalogs").getPublicUrl(p).data.publicUrl;
  }
  function size(b: number | null) {
    if (!b) return "";
    const mb = b / 1024 / 1024;
    return `${mb.toFixed(1)} MB`;
  }

  return (
    <div>
      <ModuleHeader title="Catalogs" description="Product and clearance catalogs available for download." />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.length === 0 && <p className="text-sm text-muted-foreground">No catalogs yet.</p>}
        {items.map((c) => {
          const url = urlFor(c.file_path);
          return (
            <Card key={c.id} className="p-4 flex flex-col gap-3">
              <div className="aspect-[3/4] bg-muted rounded-md flex items-center justify-center">
                <FileText className="w-12 h-12 text-muted-foreground" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">{c.name}</h3>
                <div className="mt-1 flex gap-2 flex-wrap text-xs">
                  <Badge variant="outline">{c.kind}</Badge>
                  {c.published_date && <Badge variant="outline">{c.published_date}</Badge>}
                  {c.size_bytes && <span className="text-muted-foreground">{size(c.size_bytes)}</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm" variant="outline" className="flex-1">
                  <a href={url} target="_blank" rel="noreferrer"><ExternalLink className="w-4 h-4 mr-2" />View</a>
                </Button>
                <Button asChild size="sm" className="flex-1">
                  <a href={url} download><Download className="w-4 h-4 mr-2" />Download</a>
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
