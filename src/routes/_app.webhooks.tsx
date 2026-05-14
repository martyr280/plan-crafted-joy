import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listWebhookDeliveries } from "@/lib/webhook-debug.functions";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { RefreshCw, Webhook, CheckCircle2, AlertCircle, Clock, Mail } from "lucide-react";

export const Route = createFileRoute("/_app/webhooks")({ component: WebhooksPage });

const STATUS_COLORS: Record<string, string> = {
  received: "bg-muted",
  routed: "bg-success text-success-foreground",
  needs_review: "bg-warning text-warning-foreground",
  dismissed: "bg-muted",
  error: "bg-destructive text-destructive-foreground",
};

function WebhooksPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);

  function getErrorMessage(error: unknown) {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === "string") return error;
    return "Failed to load";
  }

  async function load() {
    setLoading(true);
    try {
      const res = await listWebhookDeliveries({ data: { limit: 100 } });
      setRows(Array.isArray((res as any)?.rows) ? (res as any).rows : []);
    } catch (e: any) {
      setRows([]);
      toast.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  const total = rows.length;
  const errors = rows.filter((r) => r.status === "error").length;
  const routed = rows.filter((r) => r.status === "routed").length;
  const pending = rows.filter((r) => r.status === "received" || r.status === "needs_review").length;

  return (
    <div>
      <ModuleHeader
        title="Resend Webhook Debugger"
        description="Recent inbound webhook deliveries from Resend. Inspect raw payload, headers, and processing result."
        actions={<Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Refresh</Button>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard icon={<Webhook className="w-4 h-4" />} label="Total deliveries" value={total} />
        <StatCard icon={<CheckCircle2 className="w-4 h-4 text-success" />} label="Routed" value={routed} />
        <StatCard icon={<Clock className="w-4 h-4 text-warning" />} label="Pending / review" value={pending} />
        <StatCard icon={<AlertCircle className="w-4 h-4 text-destructive" />} label="Errors" value={errors} />
      </div>

      <Card className="mb-4">
        <div className="p-4 border-b flex items-center gap-2">
          <Mail className="w-4 h-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Latest inbound emails</h3>
          <Badge variant="outline" className="ml-auto">{Math.min(rows.length, 5)} of {rows.length}</Badge>
        </div>
        {rows.length === 0 && !loading && (
          <p className="p-6 text-sm text-muted-foreground text-center">No emails received yet.</p>
        )}
        <ul className="divide-y">
          {rows.slice(0, 5).map((r) => {
            const preview = (r.ai_summary || r.body_text || "").replace(/\s+/g, " ").trim().slice(0, 220);
            return (
              <li key={r.id} className="p-4 hover:bg-muted/30 cursor-pointer" onClick={() => setSelected(r)}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-sm truncate">{r.from_name ? `${r.from_name} <${r.from_addr}>` : r.from_addr}</span>
                  <Badge className={STATUS_COLORS[r.status] ?? ""}>{r.status.replace(/_/g, " ")}</Badge>
                  <Badge variant="outline">{r.classification}</Badge>
                  <span className="ml-auto text-xs text-muted-foreground" suppressHydrationWarning>
                    {formatDistanceToNow(new Date(r.received_at), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-sm font-medium truncate">{r.subject ?? "(no subject)"}</p>
                {preview && <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{preview}</p>}
              </li>
            );
          })}
        </ul>
      </Card>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>Processed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                <Webhook className="w-8 h-8 mx-auto mb-2 opacity-50" />
                No webhook deliveries yet. POST URL: <code>/api/public/inbound-email</code>
              </TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => setSelected(r)}>
                <TableCell className="text-sm text-muted-foreground" suppressHydrationWarning>
                  {formatDistanceToNow(new Date(r.received_at), { addSuffix: true })}
                </TableCell>
                <TableCell className="font-medium text-sm">{r.from_addr}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.to_addr ?? "—"}</TableCell>
                <TableCell className="max-w-xs truncate text-sm">{r.subject ?? "—"}</TableCell>
                <TableCell><Badge className={STATUS_COLORS[r.status] ?? ""}>{r.status.replace(/_/g, " ")}</Badge></TableCell>
                <TableCell><Badge variant="outline">{r.classification}</Badge></TableCell>
                <TableCell className="text-xs text-muted-foreground" suppressHydrationWarning>
                  {r.processed_at ? format(new Date(r.processed_at), "HH:mm:ss") : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-3xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader><SheetTitle className="break-all">{selected.subject ?? "(no subject)"}</SheetTitle></SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge className={STATUS_COLORS[selected.status] ?? ""}>{selected.status}</Badge>
                  <Badge variant="outline">{selected.classification}</Badge>
                  {selected.confidence != null && <Badge variant="outline">{Math.round(selected.confidence * 100)}% conf</Badge>}
                </div>

                <Field label="Message ID" value={selected.message_id ?? "—"} mono />
                <Field label="From" value={selected.from_addr} />
                <Field label="To" value={selected.to_addr ?? "—"} />
                <Field label="Received at" value={format(new Date(selected.received_at), "PPpp")} />
                {selected.processed_at && <Field label="Processed at" value={format(new Date(selected.processed_at), "PPpp")} />}

                {selected.error && (
                  <Card className="p-3 bg-destructive/10 border-destructive">
                    <p className="font-semibold text-xs mb-1">Error</p>
                    <pre className="text-xs whitespace-pre-wrap">{selected.error}</pre>
                  </Card>
                )}

                {selected.ai_summary && (
                  <Section title="AI summary">
                    <p className="text-sm">{selected.ai_summary}</p>
                  </Section>
                )}

                <Section title="Body (text)">
                  {selected.body_text
                    ? <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto max-h-96 whitespace-pre-wrap">{selected.body_text}</pre>
                    : <p className="text-xs text-muted-foreground">No plain-text body</p>}
                </Section>

                {selected.body_html && (
                  <Section title="Body (HTML preview)">
                    <div className="text-sm bg-muted/40 p-3 rounded overflow-x-auto max-h-96 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: selected.body_html }} />
                  </Section>
                )}

                <Section title="Headers">
                  <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto max-h-64">{JSON.stringify(selected.headers ?? {}, null, 2)}</pre>
                </Section>

                <Section title={`Attachments (${(selected.attachments as any[])?.length ?? 0})`}>
                  {(selected.attachments as any[])?.length ? (
                    <ul className="text-xs space-y-1">
                      {(selected.attachments as any[]).map((a, i) => (
                        <li key={i} className="font-mono">{a.filename ?? a.name ?? `attachment-${i}`} {a.contentType && <span className="text-muted-foreground">({a.contentType})</span>}</li>
                      ))}
                    </ul>
                  ) : <p className="text-xs text-muted-foreground">None</p>}
                </Section>

                <Section title="Webhook payload">
                  <Tabs defaultValue="webhook">
                    <TabsList>
                      <TabsTrigger value="webhook">Raw webhook</TabsTrigger>
                      <TabsTrigger value="fetched">Fetched email</TabsTrigger>
                      <TabsTrigger value="parsed">Parsed</TabsTrigger>
                      <TabsTrigger value="extracted">AI extracted</TabsTrigger>
                    </TabsList>
                    <TabsContent value="webhook">
                      <p className="text-xs text-muted-foreground mb-1">Original POST body from Resend (svix-verified).</p>
                      <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto max-h-96">{JSON.stringify(selected.raw_payload?.webhook ?? selected.raw_payload ?? {}, null, 2)}</pre>
                    </TabsContent>
                    <TabsContent value="fetched">
                      <p className="text-xs text-muted-foreground mb-1">Full email retrieved from Resend's <code>/emails/receiving/:id</code> endpoint.</p>
                      {selected.raw_payload?.fetched
                        ? <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto max-h-96">{JSON.stringify(selected.raw_payload.fetched, null, 2)}</pre>
                        : <p className="text-xs text-muted-foreground">No fetched email body (lookup may have failed — see Error above).</p>}
                    </TabsContent>
                    <TabsContent value="parsed">
                      <p className="text-xs text-muted-foreground mb-1">Normalized fields stored on the inbound_email row.</p>
                      <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto max-h-96">{JSON.stringify({
                        message_id: selected.message_id,
                        from_addr: selected.from_addr,
                        from_name: selected.from_name,
                        to_addr: selected.to_addr,
                        subject: selected.subject,
                        status: selected.status,
                        classification: selected.classification,
                        confidence: selected.confidence,
                        attachments_count: (selected.attachments as any[])?.length ?? 0,
                        body_text_length: selected.body_text?.length ?? 0,
                        body_html_length: selected.body_html?.length ?? 0,
                      }, null, 2)}</pre>
                    </TabsContent>
                    <TabsContent value="extracted">
                      <p className="text-xs text-muted-foreground mb-1">Structured data extracted by the AI classifier.</p>
                      <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto max-h-96">{JSON.stringify((selected as any).ai_extracted ?? {}, null, 2)}</pre>
                    </TabsContent>
                  </Tabs>
                </Section>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </Card>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? "font-mono text-xs break-all" : "break-all"}>{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-semibold mb-1">{title}</p>
      {children}
    </div>
  );
}
