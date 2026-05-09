import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  listInboundEmails,
  getInboundEmail,
  reclassifyInboundEmail,
  dismissInboundEmail,
  reprocessInboundEmail,
} from "@/lib/inbound-email.functions";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw, Inbox, FileText, Play } from "lucide-react";

export const Route = createFileRoute("/_app/inbox")({
  component: InboxPage,
  errorComponent: InboxError,
});

function InboxError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="p-6">
      <Card className="p-6 border-destructive/40 bg-destructive/5">
        <h2 className="font-semibold mb-2">Could not load Inbox</h2>
        <pre className="text-xs whitespace-pre-wrap text-destructive mb-4">{error?.message ?? "Unknown error"}</pre>
        <Button variant="outline" onClick={() => { router.invalidate(); reset(); }}>Retry</Button>
      </Card>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  received: "bg-muted",
  classified: "bg-muted",
  routed: "bg-success text-success-foreground",
  needs_review: "bg-warning text-warning-foreground",
  dismissed: "bg-muted",
  error: "bg-destructive text-destructive-foreground",
};

function safeRelative(d: any): string {
  if (!d) return "—";
  const t = new Date(d);
  if (isNaN(t.getTime())) return "—";
  try { return formatDistanceToNow(t, { addSuffix: true }); } catch { return "—"; }
}

function InboxPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("all");
  const [klass, setKlass] = useState("all");
  const [selected, setSelected] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await listInboundEmails({ data: { status, classification: klass, limit: 100 } });
      setRows(((res as any)?.rows ?? []) as any[]);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to load");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [status, klass]);

  async function openRow(id: string) {
    try {
      const row = await getInboundEmail({ data: { id } });
      setSelected(row);
    } catch (e: any) { toast.error(e?.message ?? "Failed"); }
  }

  const flags = Array.isArray(selected?.ai_flags) ? selected.ai_flags : [];
  const extracted = selected?.ai_extracted && typeof selected.ai_extracted === "object" ? selected.ai_extracted : {};
  const attachments = Array.isArray(selected?.attachments) ? selected.attachments : [];

  return (
    <div>
      <ModuleHeader
        title="Inbound Email"
        description="Forwarded emails are auto-classified and routed to orders, AR, damage, or logistics. Low-confidence items land here for review."
        actions={<Button variant="outline" onClick={load}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>}
      />

      <div className="flex gap-3 mb-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="classified">Classified (stuck)</SelectItem>
            <SelectItem value="needs_review">Needs review</SelectItem>
            <SelectItem value="routed">Routed</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
            <SelectItem value="error">Error</SelectItem>
          </SelectContent>
        </Select>
        <Select value={klass} onValueChange={setKlass}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="purchase_order">Purchase order</SelectItem>
            <SelectItem value="ar_reply">AR reply</SelectItem>
            <SelectItem value="damage_report">Damage report</SelectItem>
            <SelectItem value="logistics_update">Logistics update</SelectItem>
            <SelectItem value="unknown">Unknown</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>From</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Classification</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Routed to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !loading && (
              <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                <Inbox className="w-8 h-8 mx-auto mb-2 opacity-50" />
                No inbound emails yet. Configure your provider's inbound webhook to POST to <code>/api/public/inbound-email</code>.
              </TableCell></TableRow>
            )}
            {rows.map((r) => {
              const st = String(r?.status ?? "unknown");
              return (
                <TableRow key={r.id} className="cursor-pointer" onClick={() => openRow(r.id)}>
                  <TableCell className="text-sm text-muted-foreground">{safeRelative(r?.received_at)}</TableCell>
                  <TableCell className="font-medium">{r?.from_name ?? r?.from_addr ?? "—"}</TableCell>
                  <TableCell className="max-w-md truncate">{r?.subject ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline">{r?.classification ?? "unknown"}</Badge></TableCell>
                  <TableCell>{r?.confidence != null ? `${Math.round(Number(r.confidence) * 100)}%` : "—"}</TableCell>
                  <TableCell><Badge className={STATUS_COLORS[st] ?? ""}>{st.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r?.created_record_type ?? "—"}</TableCell>
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
              <SheetHeader><SheetTitle>{selected.subject ?? "(no subject)"}</SheetTitle></SheetHeader>
              <div className="mt-4 space-y-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{selected.classification ?? "unknown"}</Badge>
                  <Badge className={STATUS_COLORS[String(selected.status ?? "")] ?? ""}>{String(selected.status ?? "—")}</Badge>
                  {selected.confidence != null && <Badge variant="outline">{Math.round(Number(selected.confidence) * 100)}% conf</Badge>}
                </div>
                <div>
                  <p className="text-muted-foreground">From</p>
                  <p>{selected.from_name ? `${selected.from_name} <${selected.from_addr}>` : selected.from_addr}</p>
                </div>
                {attachments.length > 0 && (
                  <div>
                    <p className="font-semibold mb-1">Attachments ({attachments.length})</p>
                    <ul className="space-y-1">
                      {attachments.map((a: any, i: number) => (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <FileText className="w-3 h-3" />
                          <span>{a?.filename ?? "(unnamed)"}</span>
                          {a?.content_type && <span className="text-muted-foreground">· {a.content_type}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected.ai_summary && (
                  <Card className="p-3 bg-muted/40">
                    <p className="font-semibold mb-1">AI summary</p>
                    <p>{selected.ai_summary}</p>
                  </Card>
                )}
                {Object.keys(extracted).length > 0 && (
                  <div>
                    <p className="font-semibold mb-1">Extracted fields</p>
                    <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto">{JSON.stringify(extracted, null, 2)}</pre>
                  </div>
                )}
                {flags.length > 0 && (
                  <Card className="p-3 bg-warning/10 border-warning">
                    <p className="font-semibold mb-2">AI flags</p>
                    {flags.map((f: any, i: number) => (
                      <p key={i} className="text-xs"><strong>{f?.field ?? "?"}:</strong> {f?.issue ?? ""} — <em>{f?.suggestion ?? ""}</em></p>
                    ))}
                  </Card>
                )}
                <div>
                  <p className="font-semibold mb-1">Body</p>
                  <pre className="text-xs whitespace-pre-wrap bg-muted/40 p-2 rounded max-h-96 overflow-y-auto">{selected.body_text ?? "(no text body)"}</pre>
                </div>
                {selected.error && <Card className="p-3 bg-destructive/10 border-destructive text-xs">{selected.error}</Card>}
                {selected.created_record_type && (
                  <p className="text-muted-foreground">Routed to: {selected.created_record_type} {selected.created_record_id}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r: any = await reprocessInboundEmail({ data: { id: selected.id } });
                        toast.success(`Processed → ${r.status}`);
                        setSelected(null); load();
                      } catch (e: any) { toast.error(e?.message ?? "Failed"); }
                      finally { setBusy(false); }
                    }}
                  >
                    <Play className="w-4 h-4 mr-1" /> Process now
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      const r = await reclassifyInboundEmail({ data: { id: selected.id } });
                      toast.success(`Reclassified as ${(r as any).classification}`);
                      setSelected(null); load();
                    } catch (e: any) { toast.error(e?.message ?? "Failed"); }
                    finally { setBusy(false); }
                  }}>Re-classify only</Button>
                  <Button variant="outline" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      await dismissInboundEmail({ data: { id: selected.id } });
                      toast.success("Dismissed"); setSelected(null); load();
                    } catch (e: any) { toast.error(e?.message ?? "Failed"); }
                    finally { setBusy(false); }
                  }}>Dismiss</Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
