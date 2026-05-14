import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Plus, Sparkles, CheckCircle2, X, AlertCircle } from "lucide-react";
import { SifXmlImporter } from "@/components/shared/SifXmlImporter";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/lib/auth";
import { submitOrderToP21 } from "@/server/p21.functions";
import { useServerFn } from "@tanstack/react-start";

export const Route = createFileRoute("/_app/orders")({ component: OrdersPage });

function ConfBadge({ v }: { v: number | null }) {
  if (v == null) return <Badge variant="outline">—</Badge>;
  const pct = Math.round(v * 100);
  const cls = pct >= 90 ? "bg-success text-success-foreground" : pct >= 70 ? "bg-warning text-warning-foreground" : "bg-destructive text-destructive-foreground";
  return <Badge className={cls}>{pct}%</Badge>;
}

function StatusBadge({ s }: { s: string }) {
  const map: Record<string, string> = {
    pending_review: "bg-warning text-warning-foreground",
    approved: "bg-primary text-primary-foreground",
    submitted_to_p21: "bg-success text-success-foreground",
    acknowledged: "bg-success text-success-foreground",
    rejected: "bg-destructive text-destructive-foreground",
  };
  return <Badge className={map[s] ?? ""}>{s.replace(/_/g, " ")}</Badge>;
}

function OrdersPage() {
  const submitOrderToP21Fn = useServerFn(submitOrderToP21);
  const { user } = useAuth();
  const [orders, setOrders] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [parseOpen, setParseOpen] = useState(false);
  const [emailText, setEmailText] = useState("");
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [parsing, setParsing] = useState(false);
  const [stats, setStats] = useState({ today: 0, approved: 0, pending: 0 });

  async function load() {
    const { data } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
    setOrders(data ?? []);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    setStats({
      today: (data ?? []).filter((o) => new Date(o.created_at) >= today).length,
      approved: (data ?? []).filter((o) => ["submitted_to_p21", "acknowledged"].includes(o.status)).length,
      pending: (data ?? []).filter((o) => o.status === "pending_review").length,
    });
  }
  useEffect(() => { load(); }, []);

  async function fileToBase64(f: File): Promise<string> {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return btoa(bin);
  }

  async function parsePO() {
    if (!emailText.trim() && pdfFiles.length === 0) return;
    setParsing(true);
    try {
      const attachments = await Promise.all(
        pdfFiles.map(async (f) => ({ filename: f.name, content_type: f.type || "application/pdf", base64: await fileToBase64(f) }))
      );
      const { data, error } = await supabase.functions.invoke("parse-po", { body: { email_content: emailText, attachments } });
      if (error) throw error;
      const parsed = data.parsed;
      await supabase.from("orders").insert({
        customer_name: parsed.customer_name ?? "Unknown",
        customer_id: parsed.customer_id ?? null,
        po_number: parsed.po_number ?? null,
        ship_to: parsed.ship_to ?? null,
        source: "email_po",
        raw_input: emailText,
        status: "pending_review",
        line_items: parsed.line_items ?? [],
        ai_confidence: parsed.confidence ?? 0.5,
        ai_flags: parsed.flags ?? [],
      });
      await supabase.from("activity_events").insert({
        event_type: "order.received", entity_type: "order",
        actor_id: user?.id, actor_name: user?.email ?? "system",
        message: `New PO parsed from ${parsed.customer_name ?? "unknown sender"}`,
      });
      toast.success("Order parsed and added to review queue");
      setParseOpen(false); setEmailText(""); setPdfFiles([]);
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Parse failed");
    } finally { setParsing(false); }
  }

  async function approve(o: any) {
    try {
      const res = await submitOrderToP21Fn({ data: { orderId: o.id } });
      toast.success(`Submitted as ${(res as any).p21OrderId}`);
      setSelected(null);
      load();
    } catch (e: any) {
      toast.error(e.message ?? "P21 submit failed — is the bridge agent running?");
    }
  }

  async function reject(o: any) {
    await supabase.from("orders").update({ status: "rejected", reviewed_by: user?.id, reviewed_at: new Date().toISOString() }).eq("id", o.id);
    toast.success("Order rejected"); setSelected(null); load();
  }

  return (
    <div>
      <ModuleHeader title="Order Intake" description="AI-parsed POs in a human review queue. No order goes to P21 without approval."
        actions={
          <>
            <Dialog open={parseOpen} onOpenChange={setParseOpen}>
              <DialogTrigger asChild>
                <Button><Sparkles className="w-4 h-4 mr-2" /> Parse Email PO</Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader><DialogTitle>Parse PO from email</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <Label>Paste the email body</Label>
                  <Textarea rows={10} value={emailText} onChange={(e) => setEmailText(e.target.value)}
                    placeholder="From: orders@apexarch.com&#10;Subject: PO 77821&#10;&#10;Please process the following order..." />
                  <div>
                    <Label>Attach PDF purchase orders (optional)</Label>
                    <Input type="file" accept="application/pdf" multiple
                      onChange={(e) => setPdfFiles(Array.from(e.target.files ?? []))} />
                    {pdfFiles.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">{pdfFiles.length} PDF{pdfFiles.length > 1 ? "s" : ""} attached — will be read by AI and prices verified against the price list.</p>
                    )}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setParseOpen(false)}>Cancel</Button>
                    <Button onClick={parsePO} disabled={parsing || (!emailText.trim() && pdfFiles.length === 0)}>{parsing ? "Parsing…" : "Parse with AI"}</Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
            <SifXmlImporter scope="orders" onImported={load} />
            <Button variant="outline"><Plus className="w-4 h-4 mr-2" /> New Order</Button>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Today received</p><p className="text-2xl font-bold">{stats.today}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Pending review</p><p className="text-2xl font-bold">{stats.pending}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Submitted</p><p className="text-2xl font-bold">{stats.approved}</p></Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead><TableHead>Customer</TableHead><TableHead>PO #</TableHead>
              <TableHead>Lines</TableHead><TableHead>AI Confidence</TableHead><TableHead>Flags</TableHead>
              <TableHead>Status</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id} className="cursor-pointer" onClick={() => setSelected(o)}>
                <TableCell className="text-sm text-muted-foreground">{formatDistanceToNow(new Date(o.created_at), { addSuffix: true })}</TableCell>
                <TableCell className="font-medium">{o.customer_name}</TableCell>
                <TableCell>{o.po_number ?? "—"}</TableCell>
                <TableCell>{(o.line_items as any[])?.length ?? 0}</TableCell>
                <TableCell><ConfBadge v={o.ai_confidence} /></TableCell>
                <TableCell>{(o.ai_flags as any[])?.length ? <span className="inline-flex items-center gap-1 text-warning text-sm"><AlertCircle className="w-3 h-3" />{(o.ai_flags as any[]).length}</span> : "—"}</TableCell>
                <TableCell><StatusBadge s={o.status} /></TableCell>
                <TableCell><Button size="sm" variant="ghost">Review</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader><SheetTitle>{selected.customer_name} · PO {selected.po_number ?? "—"}</SheetTitle></SheetHeader>
              <div className="mt-4 space-y-4">
                <div className="flex gap-2"><StatusBadge s={selected.status} /><ConfBadge v={selected.ai_confidence} /></div>
                {(selected.ai_flags as any[])?.length > 0 && (
                  <Card className="p-3 bg-warning/10 border-warning">
                    <p className="font-semibold text-sm mb-2">AI flags</p>
                    {(selected.ai_flags as any[]).map((f, i) => (
                      <p key={i} className="text-xs"><strong>{f.field}:</strong> {f.issue} — <em>{f.suggestion}</em></p>
                    ))}
                  </Card>
                )}
                <div>
                  <p className="font-semibold text-sm mb-2">Line items</p>
                  <Table>
                    <TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Description</TableHead><TableHead>Qty</TableHead><TableHead>Unit</TableHead><TableHead>List</TableHead><TableHead>Total</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {(selected.line_items as any[]).map((li, i) => {
                        const m = li.price_list_match;
                        const source = m?.source;
                        const list = m?.list_price;
                        const unit = Number(li.unit_price);
                        const unknown = !m;
                        const catalogOnly = source === "catalog";
                        const mismatch = source === "contract" && list != null && Number.isFinite(unit) && Math.abs(Number(list) - unit) > 0.01;
                        const cls = unknown ? "bg-destructive/10" : (mismatch || catalogOnly) ? "bg-warning/10" : "";
                        return (
                          <TableRow key={i} className={cls}>
                            <TableCell>{li.sku}</TableCell>
                            <TableCell>{li.description}</TableCell>
                            <TableCell>{li.qty}</TableCell>
                            <TableCell>${li.unit_price}</TableCell>
                            <TableCell className="text-xs">
                              {unknown ? (
                                <span className="text-destructive">not found</span>
                              ) : catalogOnly ? (
                                <span title={`From catalog (page ${m.page ?? "?"})`}>
                                  ${list != null ? Number(list).toFixed(2) : "—"} <span className="text-muted-foreground">(catalog)</span>
                                </span>
                              ) : (
                                `$${Number(list).toFixed(2)}`
                              )}
                            </TableCell>
                            <TableCell>${li.line_total ?? li.qty * li.unit_price}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {selected.status === "pending_review" && (
                  <div className="flex gap-2">
                    <Button onClick={() => approve(selected)} className="flex-1"><CheckCircle2 className="w-4 h-4 mr-2" /> Approve & Submit to P21</Button>
                    <Button variant="outline" onClick={() => reject(selected)}><X className="w-4 h-4 mr-2" /> Reject</Button>
                  </div>
                )}
                {selected.p21_order_id && <p className="text-sm text-muted-foreground">P21 ID: {selected.p21_order_id}</p>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
