import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Sparkles, CheckCircle2, X, AlertCircle, RefreshCw, Loader2, Info } from "lucide-react";
import { SifXmlImporter } from "@/components/shared/SifXmlImporter";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useAuth } from "@/lib/auth";
import { submitOrderToP21 } from "@/lib/p21.functions";
import { reExtractOrderLineItems, resolveOrderLineSku } from "@/lib/inbound-email.functions";
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
  const reExtractFn = useServerFn(reExtractOrderLineItems);
  const resolveSkuFn = useServerFn(resolveOrderLineSku);
  const { user } = useAuth();
  const [orders, setOrders] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [parseOpen, setParseOpen] = useState(false);
  const [emailText, setEmailText] = useState("");
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [parsing, setParsing] = useState(false);
  const [reExtracting, setReExtracting] = useState(false);
  const [missingOnly, setMissingOnly] = useState(false);
  const [stats, setStats] = useState({ today: 0, approved: 0, pending: 0, missing: 0 });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState<any | null>(null);
  const [confirmReject, setConfirmReject] = useState<any | null>(null);

  async function load() {
    const { data } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
    setOrders(data ?? []);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    setStats({
      today: (data ?? []).filter((o) => new Date(o.created_at) >= today).length,
      approved: (data ?? []).filter((o) => ["submitted_to_p21", "acknowledged"].includes(o.status)).length,
      pending: (data ?? []).filter((o) => o.status === "pending_review").length,
      missing: (data ?? []).filter((o) => o.status === "pending_review" && ((o.line_items as any[])?.length ?? 0) === 0).length,
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
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await submitOrderToP21Fn({ data: { orderId: o.id, idempotencyKey: o.id } });
      const r = res as { p21OrderId: string; alreadySubmitted?: boolean };
      toast.success(r.alreadySubmitted ? `Already submitted as ${r.p21OrderId}` : `Submitted as ${r.p21OrderId}`);
      setConfirmApprove(null);
      setSelected(null);
      load();
    } catch (e: any) {
      toast.error(e.message ?? "P21 submit failed — is the bridge agent running?");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function reject(o: any) {
    if (rejecting) return;
    setRejecting(true);
    try {
      const { error } = await supabase.from("orders").update({ status: "rejected", reviewed_by: user?.id, reviewed_at: new Date().toISOString() }).eq("id", o.id);
      if (error) throw error;
      toast.success("Order rejected");
      setConfirmReject(null); setSelected(null); load();
    } catch (e: any) {
      toast.error(e?.message ?? "Reject failed");
    } finally {
      setRejecting(false);
    }
  }

  function orderTotal(o: any) {
    return ((o?.line_items as any[]) ?? []).reduce(
      (s, li) => s + (Number(li.line_total ?? (Number(li.qty) || 0) * (Number(li.unit_price) || 0)) || 0),
      0,
    );
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
                  <Label htmlFor="parse-po-email">Paste the email body</Label>
                  <Textarea id="parse-po-email" rows={10} value={emailText} onChange={(e) => setEmailText(e.target.value)}
                    placeholder="From: orders@apexarch.com&#10;Subject: PO 77821&#10;&#10;Please process the following order..." />
                  <div>
                    <Label htmlFor="parse-po-pdfs">Attach PDF purchase orders (optional)</Label>
                    <Input id="parse-po-pdfs" type="file" accept="application/pdf" multiple
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
          </>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card className="p-4"><p className="text-sm text-muted-foreground">Today received</p><p className="text-2xl font-bold">{stats.today}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Pending review</p><p className="text-2xl font-bold">{stats.pending}</p></Card>
        <Card className="p-4"><p className="text-sm text-muted-foreground">Submitted</p><p className="text-2xl font-bold">{stats.approved}</p></Card>
        <button
          type="button"
          aria-pressed={missingOnly}
          className={`rounded-xl border bg-card text-card-foreground shadow-sm p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${missingOnly ? "border-warning bg-warning/5" : "hover:bg-muted/40"}`}
          onClick={() => setMissingOnly((v) => !v)}
        >
          <p className="text-sm text-muted-foreground">Missing line items</p>
          <p className="text-2xl font-bold text-warning-text">{stats.missing}</p>
          <p className="text-xs text-muted-foreground mt-1">{missingOnly ? "Filtering" : "Click to filter"}</p>
        </button>
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
            {orders
              .filter((o) => !missingOnly || (o.status === "pending_review" && ((o.line_items as any[])?.length ?? 0) === 0))
              .map((o) => {
                const lines = (o.line_items as any[])?.length ?? 0;
                const missing = o.status === "pending_review" && lines === 0;
                return (
                  <TableRow key={o.id} className="cursor-pointer" onClick={() => setSelected(o)}>
                    <TableCell className="text-sm text-muted-foreground">{formatDistanceToNow(new Date(o.created_at), { addSuffix: true })}</TableCell>
                    <TableCell className="font-medium">{o.customer_name}</TableCell>
                    <TableCell>{o.po_number ?? "—"}</TableCell>
                    <TableCell>{missing ? <span className="text-warning-text font-medium">0 ⚠</span> : lines}</TableCell>
                    <TableCell><ConfBadge v={o.ai_confidence} /></TableCell>
                    <TableCell>{(o.ai_flags as any[])?.length ? <span className="inline-flex items-center gap-1 text-warning-text text-sm"><AlertCircle className="w-3 h-3" />{(o.ai_flags as any[]).length}</span> : "—"}</TableCell>
                    <TableCell><StatusBadge s={o.status} /></TableCell>
                    <TableCell><Button size="sm" variant="ghost">Review</Button></TableCell>
                  </TableRow>
                );
              })}
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
                  <Card className="p-3">
                    <p className="font-semibold text-sm mb-2">AI flags</p>
                    {(selected.ai_flags as any[]).map((f, i) => {
                      const sev = f.severity ?? (f.type === "contract_or_price_match" ? "info" : "warning");
                      const cls = sev === "error"
                        ? "text-destructive-text"
                        : sev === "warning"
                          ? "text-warning-text"
                          : "text-muted-foreground";
                      const Icon = sev === "info" ? Info : AlertCircle;
                      return (
                        <p key={i} className={`text-xs flex items-start gap-1 ${cls}`}>
                          <Icon className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" />
                          <span><strong>{f.field}:</strong> {f.issue}{f.suggestion ? <> — <em>{f.suggestion}</em></> : null}</span>
                        </p>
                      );
                    })}
                  </Card>
                )}
                <div>
                  <p className="font-semibold text-sm mb-2">Line items</p>
                  <Table>
                    <TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Description</TableHead><TableHead>Qty</TableHead><TableHead>Unit</TableHead><TableHead>Match / List</TableHead><TableHead>Total</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {(selected.line_items as any[]).map((li, i) => {
                        const m = li.price_list_match;
                        const source = m?.source;
                        const list = m?.list_price;
                        const unit = Number(li.unit_price);
                        const unknown = !m;
                        const catalogOnly = source === "catalog" || source === "e2g";
                        const ambiguous = source === "candidates";
                        const cls = unknown
                          ? "bg-destructive/10"
                          : (catalogOnly || ambiguous)
                            ? "bg-warning/10"
                            : "";
                        return (
                          <TableRow key={i} className={cls}>
                            <TableCell>
                              <div className="font-mono text-xs">{li.sku}</div>
                              {m?.matched_sku && m.matched_sku !== li.sku && (
                                <div className="text-[10px] text-muted-foreground">→ {m.matched_sku}</div>
                              )}
                              <div className="flex gap-1 mt-1 flex-wrap">
                                {m?.match_method && (
                                  <Badge variant="outline" className="text-[10px]">{m.match_method}</Badge>
                                )}
                                {m?.price_level && (
                                  <Badge className="text-[10px] bg-primary/15 text-primary border-primary/30">{m.price_level}</Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell>{li.description}</TableCell>
                            <TableCell>{li.qty}</TableCell>
                            <TableCell>${li.unit_price}</TableCell>
                            <TableCell className="text-xs">
                              {unknown ? (
                                <span className="text-destructive">not found</span>
                              ) : ambiguous ? (
                                <CandidatePicker
                                  candidates={m.candidates ?? []}
                                  onPick={async (sku, remember) => {
                                    try {
                                      await resolveSkuFn({ data: { orderId: selected.id, lineIndex: i, chosenSku: sku, rememberMapping: remember } });
                                      toast.success(remember ? "Mapped and remembered" : "Line resolved");
                                      const { data } = await supabase.from("orders").select("*").eq("id", selected.id).single();
                                      setSelected(data); load();
                                    } catch (e: any) { toast.error(e?.message ?? "Failed"); }
                                  }}
                                />
                              ) : catalogOnly ? (
                                <span title={source === "e2g" ? "From E2G inventory upload" : `From catalog (page ${m.page ?? "?"})`}>
                                  ${list != null ? Number(list).toFixed(2) : "—"} <span className="text-muted-foreground">({source})</span>
                                </span>
                              ) : (
                                `$${list != null ? Number(list).toFixed(2) : "—"}`
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
                  <div className="flex gap-2 flex-wrap">
                    <Button onClick={() => setConfirmApprove(selected)} disabled={submitting} className="flex-1">
                      {submitting
                        ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</>
                        : <><CheckCircle2 className="w-4 h-4 mr-2" /> Approve & Submit to P21</>}
                    </Button>
                    <Button variant="outline" disabled={reExtracting} onClick={async () => {
                      setReExtracting(true);
                      try {
                        const r: any = await reExtractFn({ data: { orderId: selected.id } });
                        toast.success(`Re-extracted ${r.line_count} line item(s)`);
                        setSelected(null); load();
                      } catch (e: any) { toast.error(e?.message ?? "Re-extract failed"); }
                      finally { setReExtracting(false); }
                    }}>
                      <RefreshCw className={`w-4 h-4 mr-2 ${reExtracting ? "animate-spin" : ""}`} />
                      Re-extract line items
                    </Button>
                    <Button variant="outline" disabled={submitting || rejecting} onClick={() => setConfirmReject(selected)}><X className="w-4 h-4 mr-2" /> Reject</Button>
                  </div>
                )}
                {selected.p21_order_id && <p className="text-sm text-muted-foreground">P21 ID: {selected.p21_order_id}</p>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirmApprove} onOpenChange={(o) => { if (!o && !submitting) setConfirmApprove(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Submit this order to P21?</AlertDialogTitle>
            <AlertDialogDescription>This creates a real order in P21. Check the summary first.</AlertDialogDescription>
          </AlertDialogHeader>
          {confirmApprove && (
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Customer</dt><dd className="font-medium">{confirmApprove.customer_name}</dd>
              <dt className="text-muted-foreground">PO #</dt><dd>{confirmApprove.po_number ?? "—"}</dd>
              <dt className="text-muted-foreground">Lines</dt><dd>{(confirmApprove.line_items as any[])?.length ?? 0}</dd>
              <dt className="text-muted-foreground">Total</dt><dd className="font-medium">${orderTotal(confirmApprove).toFixed(2)}</dd>
            </dl>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(e) => { e.preventDefault(); if (confirmApprove) approve(confirmApprove); }}
            >
              {submitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…</> : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmReject} onOpenChange={(o) => { if (!o && !rejecting) setConfirmReject(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this order?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmReject ? `${confirmReject.customer_name} · PO ${confirmReject.po_number ?? "—"} will be marked rejected and won't be sent to P21.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rejecting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rejecting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); if (confirmReject) reject(confirmReject); }}
            >
              {rejecting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Rejecting…</> : "Reject order"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CandidatePicker({
  candidates,
  onPick,
}: {
  candidates: Array<{ item: string; description?: string }>;
  onPick: (sku: string, remember: boolean) => void | Promise<void>;
}) {
  const [choice, setChoice] = useState<string>(candidates[0]?.item ?? "");
  const [remember, setRemember] = useState(false);
  if (!candidates.length) return <span className="text-warning-text">ambiguous</span>;
  return (
    <div className="space-y-1">
      <div className="text-warning-text text-xs">Pick a finish:</div>
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className="w-full h-8 border rounded px-2 text-xs bg-background"
      >
        {candidates.map((c) => (
          <option key={c.item} value={c.item}>{c.item}{c.description ? ` — ${c.description.slice(0, 40)}` : ""}</option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <input className="h-4 w-4" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> remember this mapping
      </label>
      <Button size="sm" variant="outline" className="h-8 text-xs px-3" onClick={() => choice && onPick(choice, remember)}>
        Apply
      </Button>
    </div>
  );
}
