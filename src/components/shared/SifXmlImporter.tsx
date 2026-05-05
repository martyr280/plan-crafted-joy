import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Upload, FileUp, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { parseSifText, type ImportKind, type ParsedOrder, type ParsedLoad, type RowError } from "@/lib/sif-parser";

type Props = {
  scope: "orders" | "loads" | "both";
  onImported?: () => void;
  triggerLabel?: string;
};

export function SifXmlImporter({ scope, onImported, triggerLabel = "Import SIF/XML" }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = text ? parseSifText(text) : null;
  const records = parsed?.records ?? [];
  const errors: RowError[] = parsed?.errors ?? [];
  const kind: ImportKind | null = parsed?.kind ?? null;
  const scopeMismatch = parsed && scope !== "both" && parsed.kind !== scope && records.length > 0;

  async function pickFile(f: File) {
    if (f.size > 5 * 1024 * 1024) { toast.error("File too large (max 5MB)"); return; }
    setFileName(f.name);
    setText(await f.text());
  }

  function reset() {
    setText("");
    setFileName(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function doImport() {
    if (!parsed || !records.length || scopeMismatch) return;
    setImporting(true);
    try {
      const user = (await supabase.auth.getUser()).data.user;
      if (parsed.kind === "orders") {
        const rows = (records as ParsedOrder[]).map((r) => ({
          po_number: r.po_number,
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          source: r.source,
          line_items: r.line_items,
          status: "pending_review",
          ai_flags: [],
        }));
        const { error } = await supabase.from("orders").insert(rows);
        if (error) throw error;
        await supabase.from("activity_events").insert({
          event_type: "orders_imported",
          actor_id: user?.id ?? null,
          actor_name: user?.email ?? "import",
          message: `Imported ${rows.length} orders from ${fileName ?? "paste"}`,
          entity_type: "orders",
          metadata: { count: rows.length, errors: errors.length, source_file: fileName },
        });
        toast.success(`Imported ${rows.length} order${rows.length === 1 ? "" : "s"}`);
      } else {
        const rows = (records as ParsedLoad[]).map((r) => ({
          route_code: r.route_code,
          truck_id: r.truck_id,
          driver_name: r.driver_name,
          departure_date: r.departure_date,
          orders: r.orders,
          status: "loading",
        }));
        const { error } = await supabase.from("fleet_loads").insert(rows);
        if (error) throw error;
        await supabase.from("activity_events").insert({
          event_type: "loads_imported",
          actor_id: user?.id ?? null,
          actor_name: user?.email ?? "import",
          message: `Imported ${rows.length} fleet loads from ${fileName ?? "paste"}`,
          entity_type: "fleet_loads",
          metadata: { count: rows.length, errors: errors.length, source_file: fileName },
        });
        toast.success(`Imported ${rows.length} load${rows.length === 1 ? "" : "s"}`);
      }
      reset();
      setOpen(false);
      onImported?.();
    } catch (e: any) {
      toast.error(e.message ?? "Import failed");
    } finally {
      setImporting(false);
    }
  }

  const sampleOrders = `# SIF Orders sample
ORD|PO-1001|C-100|Acme Lumber|email
LIN|PO-1001|2x4-8FT|240|3.45
LIN|PO-1001|PLY-3/4|40|45.00
ORD|PO-1002|C-200|Bay City Builders|edi
LIN|PO-1002|OSB-7/16|120|18.75`;
  const sampleLoads = `# SIF Loads sample
LOD|RT-NORTH-01|T-77|Jane Driver|2026-05-10
REF|RT-NORTH-01|SO-44231
REF|RT-NORTH-01|SO-44232`;

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline"><FileUp className="w-4 h-4 mr-2" />{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import SIF / XML</DialogTitle>
          <DialogDescription>
            Upload or paste a SIF (pipe-delimited) or XML file. The format is auto-detected for {scope === "both" ? "Orders or Loads" : scope === "orders" ? "Orders" : "Loads"}.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="upload">
          <TabsList>
            <TabsTrigger value="upload">Upload</TabsTrigger>
            <TabsTrigger value="paste">Paste</TabsTrigger>
            <TabsTrigger value="format">Format reference</TabsTrigger>
          </TabsList>

          <TabsContent value="upload">
            <div className="border-2 border-dashed rounded-md p-8 text-center">
              <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground mb-3">{fileName ?? "Choose a .sif, .txt, or .xml file"}</p>
              <input
                ref={fileRef}
                type="file"
                accept=".sif,.txt,.xml,text/xml,application/xml,text/plain"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); }}
              />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>Select file</Button>
              {fileName && <Button variant="ghost" size="sm" onClick={reset} className="ml-2">Clear</Button>}
            </div>
          </TabsContent>

          <TabsContent value="paste">
            <Textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setFileName(null); }}
              placeholder="Paste SIF or XML content here…"
              className="min-h-[160px] font-mono text-xs"
            />
          </TabsContent>

          <TabsContent value="format">
            <div className="space-y-3 text-xs">
              <div>
                <div className="font-semibold mb-1">SIF Orders</div>
                <pre className="bg-muted p-2 rounded">{sampleOrders}</pre>
              </div>
              <div>
                <div className="font-semibold mb-1">SIF Loads</div>
                <pre className="bg-muted p-2 rounded">{sampleLoads}</pre>
              </div>
              <div className="text-muted-foreground">
                XML is also accepted: <code>&lt;orders&gt;&lt;order po=… customerName=…&gt;&lt;line sku=… qty=… price=…/&gt;&lt;/order&gt;&lt;/orders&gt;</code>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {parsed && (
          <div className="border rounded-md">
            <div className="flex items-center justify-between p-3 border-b bg-muted/30">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{kind}</Badge>
                <span className="text-sm">{records.length} valid record{records.length === 1 ? "" : "s"}</span>
                {errors.length > 0 && (
                  <Badge variant="destructive"><AlertCircle className="w-3 h-3 mr-1" />{errors.length} error{errors.length === 1 ? "" : "s"}</Badge>
                )}
                {!errors.length && records.length > 0 && (
                  <Badge className="bg-success text-success-foreground"><CheckCircle2 className="w-3 h-3 mr-1" />Ready to import</Badge>
                )}
              </div>
            </div>
            <ScrollArea className="max-h-64">
              <div className="p-3 space-y-3">
                {scopeMismatch && (
                  <div className="text-sm text-destructive">File contains {kind} but this importer only accepts {scope}.</div>
                )}
                {errors.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-destructive mb-1">Validation errors</div>
                    <ul className="text-xs space-y-1">
                      {errors.slice(0, 50).map((e, i) => (
                        <li key={i}><span className="font-mono text-muted-foreground">L{e.line}:</span> {e.message}</li>
                      ))}
                      {errors.length > 50 && <li className="text-muted-foreground">…and {errors.length - 50} more</li>}
                    </ul>
                  </div>
                )}
                {records.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold mb-1">Preview</div>
                    <ul className="text-xs space-y-1">
                      {records.slice(0, 20).map((r: any, i) => (
                        <li key={i} className="font-mono">
                          {kind === "orders"
                            ? `${r.po_number} · ${r.customer_name} · ${r.line_items.length} line(s)`
                            : `${r.route_code} · truck ${r.truck_id ?? "—"} · ${r.orders.length} order(s)`}
                        </li>
                      ))}
                      {records.length > 20 && <li className="text-muted-foreground">…and {records.length - 20} more</li>}
                    </ul>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={doImport} disabled={!records.length || importing || !!scopeMismatch}>
            {importing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
            Import {records.length > 0 ? `${records.length} ${kind}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
