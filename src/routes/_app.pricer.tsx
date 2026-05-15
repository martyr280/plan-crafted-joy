import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  recomputeSkuFamilies, listSkuFamilies, updateFamilyPrices,
  probeFamilyImage, listFamilyImages,
  generatePricerPdf, listPricerPublications, listPricerFilters,
} from "@/lib/pricer.functions";
import { Loader2, RefreshCw, FileDown, Image as ImageIcon, Search, Upload } from "lucide-react";

export const Route = createFileRoute("/_app/pricer")({ component: PricerPage });

type FamilyRow = {
  item_short: string; rep: any; count: number; finishes: string[]; missingLevels: string[];
};

function PricerPage() {
  return (
    <div>
      <ModuleHeader title="Pricer" description="Generate landscape and per-level portrait price sheets" />
      <Tabs defaultValue="builder">
        <TabsList>
          <TabsTrigger value="builder">Pricer Builder</TabsTrigger>
          <TabsTrigger value="families">SKU Families</TabsTrigger>
          <TabsTrigger value="images">Item Images</TabsTrigger>
          <TabsTrigger value="publications">Publications</TabsTrigger>
        </TabsList>
        <TabsContent value="builder"><BuilderTab /></TabsContent>
        <TabsContent value="families"><FamiliesTab /></TabsContent>
        <TabsContent value="images"><ImagesTab /></TabsContent>
        <TabsContent value="publications"><PublicationsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// -------------------- Builder --------------------
function BuilderTab() {
  const fnGenerate = useServerFn(generatePricerPdf);
  const fnFilters = useServerFn(listPricerFilters);
  const [name, setName] = useState(`Pricer ${new Date().toISOString().slice(0, 10)}`);
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [level, setLevel] = useState<"list" | "l1" | "l2" | "l3" | "l4" | "l5">("list");
  const [category, setCategory] = useState<string>("");
  const [mfg, setMfg] = useState<string>("");
  const [inStockOnly, setInStockOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState<{ categories: string[]; mfgs: string[] }>({ categories: [], mfgs: [] });

  useEffect(() => { fnFilters({ data: undefined as any }).then(setOpts).catch(() => {}); }, [fnFilters]);

  async function onGenerate() {
    setBusy(true);
    try {
      const res = await fnGenerate({ data: {
        name, orientation,
        portrait_level: orientation === "portrait" ? level : null,
        filters: {
          category: category || null,
          mfg: mfg || null,
          in_stock_only: inStockOnly,
          search: search || null,
        },
      }});
      toast.success(`Generated PDF (${res.row_count} families)`);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to generate");
    } finally { setBusy(false); }
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Orientation</Label>
          <Select value={orientation} onValueChange={(v: any) => setOrientation(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="landscape">Landscape (all 6 levels)</SelectItem>
              <SelectItem value="portrait">Portrait (single level + image)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {orientation === "portrait" && (
          <div>
            <Label>Price level</Label>
            <Select value={level} onValueChange={(v: any) => setLevel(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["list", "l1", "l2", "l3", "l4", "l5"] as const).map((l) => (
                  <SelectItem key={l} value={l}>{l === "list" ? "List" : l.toUpperCase()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <Label>Category</Label>
          <Select value={category || "__all"} onValueChange={(v) => setCategory(v === "__all" ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All categories</SelectItem>
              {opts.categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Manufacturer</Label>
          <Select value={mfg || "__all"} onValueChange={(v) => setMfg(v === "__all" ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All manufacturers</SelectItem>
              {opts.mfgs.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Search (item / description)</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="optional" />
        </div>
        <div className="flex items-center gap-2 pt-6">
          <Switch checked={inStockOnly} onCheckedChange={setInStockOnly} />
          <Label>In-stock only (E2G)</Label>
        </div>
      </div>
      <div className="pt-2">
        <Button onClick={onGenerate} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Generate PDF
        </Button>
      </div>
    </Card>
  );
}

// -------------------- Families --------------------
function FamiliesTab() {
  const fnList = useServerFn(listSkuFamilies);
  const fnRecompute = useServerFn(recomputeSkuFamilies);
  const fnUpdate = useServerFn(updateFamilyPrices);
  const [rows, setRows] = useState<FamilyRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await fnList({ data: { search: search || undefined } });
      setRows(r.families as any);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function onRecompute() {
    setBusy(true);
    try {
      const r = await fnRecompute({ data: undefined as any });
      toast.success(`Recomputed families (${r.updated} rows updated)`);
      await load();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  async function patchPrice(item_short: string, field: string, value: string) {
    const num = value.trim() === "" ? null : Number(value);
    if (num !== null && Number.isNaN(num)) return;
    try {
      await fnUpdate({ data: { item_short, [field]: num } as any });
      setRows((rs) => rs.map((r) => r.item_short === item_short ? { ...r, rep: { ...r.rep, [field]: num } } : r));
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <Card>
      <div className="flex items-center justify-between p-3 border-b gap-2">
        <div className="relative w-72">
          <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search families…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}><RefreshCw className="w-4 h-4" /> Reload</Button>
          <Button size="sm" onClick={onRecompute} disabled={busy}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Recompute families</Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Short PN</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Finishes</TableHead>
            <TableHead className="text-right">List</TableHead>
            <TableHead className="text-right">L1</TableHead>
            <TableHead className="text-right">L2</TableHead>
            <TableHead className="text-right">L3</TableHead>
            <TableHead className="text-right">L4</TableHead>
            <TableHead className="text-right">L5</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={9} className="text-center py-6 text-muted-foreground">Loading…</TableCell></TableRow>}
          {!loading && rows.length === 0 && <TableRow><TableCell colSpan={9} className="text-center py-6 text-muted-foreground">No families. Click Recompute.</TableCell></TableRow>}
          {rows.map((f) => (
            <TableRow key={f.item_short}>
              <TableCell className="font-mono text-xs">{f.item_short}<div className="text-[10px] text-muted-foreground">{f.count} finish{f.count === 1 ? "" : "es"}</div></TableCell>
              <TableCell className="max-w-xs truncate">{f.rep?.description ?? "—"}</TableCell>
              <TableCell className="text-xs text-muted-foreground max-w-xs truncate">{f.finishes.join(" · ") || "—"}</TableCell>
              {(["list_price", "price_l1", "price_l2", "price_l3", "price_l4", "price_l5"] as const).map((col) => (
                <TableCell key={col} className="text-right">
                  <Input
                    className="h-7 text-right text-xs w-20 ml-auto"
                    defaultValue={f.rep?.[col] ?? ""}
                    onBlur={(e) => {
                      const val = e.target.value;
                      const old = f.rep?.[col];
                      if (String(old ?? "") !== val) patchPrice(f.item_short, col, val);
                    }}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// -------------------- Images --------------------
function ImagesTab() {
  const fnList = useServerFn(listFamilyImages);
  const fnProbe = useServerFn(probeFamilyImage);
  const [filter, setFilter] = useState<"all" | "missing">("all");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try { const r = await fnList({ data: { filter } }); setRows(r.families); } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  async function onProbe(item_short: string) {
    try {
      const r = await fnProbe({ data: { item_short } });
      if (r.url) toast.success(`Found image for ${item_short}`); else toast.error(`No image for ${item_short}`);
      await load();
    } catch (e: any) { toast.error(e.message); }
  }

  async function onUpload(item_short: string, file: File) {
    const path = `${item_short}.${file.name.split(".").pop() || "jpg"}`;
    const { error } = await supabase.storage.from("pricer-images").upload(path, file, { upsert: true, contentType: file.type });
    if (error) { toast.error(error.message); return; }
    await supabase.from("sku_family_image_overrides").upsert({ item_short, image_path: path });
    toast.success(`Uploaded override for ${item_short}`);
    await load();
  }

  return (
    <Card>
      <div className="flex items-center justify-between p-3 border-b gap-2">
        <Select value={filter} onValueChange={(v: any) => setFilter(v)}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All families</SelectItem>
            <SelectItem value="missing">Missing image only</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /> Reload</Button>
      </div>
      {loading && <div className="p-6 text-center text-muted-foreground">Loading…</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 p-3">
        {rows.map((r) => {
          const url = r.override_url ?? r.live_url;
          return (
            <div key={r.item_short} className="border rounded p-2 flex flex-col items-center gap-2">
              <div className="w-full aspect-square bg-muted flex items-center justify-center overflow-hidden">
                {url ? <img src={url} alt={r.item_short} className="object-contain w-full h-full" /> : <ImageIcon className="w-8 h-8 text-muted-foreground" />}
              </div>
              <div className="text-xs font-mono">{r.item_short}</div>
              <div className="text-[10px] text-muted-foreground">{r.member_count} finishes</div>
              <div className="flex gap-1 w-full">
                <Button size="sm" variant="outline" className="flex-1 h-7 text-[10px]" onClick={() => onProbe(r.item_short)}>Probe</Button>
                <label className="flex-1">
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onUpload(r.item_short, e.target.files[0])} />
                  <span className="inline-flex items-center justify-center gap-1 h-7 w-full text-[10px] border rounded cursor-pointer hover:bg-accent"><Upload className="w-3 h-3" />Upload</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// -------------------- Publications --------------------
function PublicationsTab() {
  const fnList = useServerFn(listPricerPublications);
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  async function load() {
    setLoading(true);
    try { const r = await fnList({ data: undefined as any }); setRows(r.publications); } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  return (
    <Card>
      <div className="flex justify-end p-3 border-b">
        <Button size="sm" variant="outline" onClick={load}><RefreshCw className="w-4 h-4" /> Reload</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Orientation</TableHead>
            <TableHead>Level</TableHead>
            <TableHead>Rows</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Generated</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">Loading…</TableCell></TableRow>}
          {!loading && rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">No publications yet.</TableCell></TableRow>}
          {rows.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.name}</TableCell>
              <TableCell><Badge variant="outline">{p.orientation}</Badge></TableCell>
              <TableCell className="text-xs">{p.portrait_level ?? "—"}</TableCell>
              <TableCell>{p.row_count}</TableCell>
              <TableCell>
                <Badge variant={p.status === "ready" ? "default" : p.status === "error" ? "destructive" : "secondary"}>{p.status}</Badge>
                {p.error && <div className="text-[10px] text-destructive mt-1">{p.error}</div>}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{new Date(p.generated_at).toLocaleString()}</TableCell>
              <TableCell>
                {p.status === "ready" && p.signed_url ? (
                  <a href={p.signed_url} target="_blank" rel="noreferrer" download>
                    <Button size="sm" variant="default"><FileDown className="w-3 h-3 mr-1" /> Download PDF</Button>
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
