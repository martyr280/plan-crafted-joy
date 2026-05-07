import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listInboundEmails, getInboundEmail, reclassifyInboundEmail, dismissInboundEmail } from "@/lib/inbound-email.functions";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw, Inbox } from "lucide-react";

export const Route = createFileRoute("/_app/inbox")({ component: InboxPage });

const STATUS_COLORS: Record<string, string> = {
  received: "bg-muted",
  routed: "bg-success text-success-foreground",
  needs_review: "bg-warning text-warning-foreground",
  dismissed: "bg-muted",
  error: "bg-destructive text-destructive-foreground",
};

function InboxPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("all");
  const [klass, setKlass] = useState("all");
  const [selected, setSelected] = useState<any | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await listInboundEmails({ data: { status, classification: klass, limit: 100 } });
      setRows((res as any).rows);
    } catch (e: any) {
      toast.error(e.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [status, klass]);

  async function openRow(id: string) {
    try {
      const row = await getInboundEmail({ data: { id } });
      setSelected(row);
    } catch (e: any) { toast.error(e.message); }
  }

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
            {rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => openRow(r.id)}>
                <TableCell className="text-sm text-muted-foreground">{formatDistanceToNow(new Date(r.received_at), { addSuffix: true })}</TableCell>
                <TableCell className="font-medium">{r.from_name ?? r.from_addr}</TableCell>
                <TableCell className="max-w-md truncate">{r.subject ?? "—"}</TableCell>
                <TableCell><Badge variant="outline">{r.classification}</Badge></TableCell>
                <TableCell>{r.confidence != null ? `${Math.round(r.confidence * 100)}%` : "—"}</TableCell>
                <TableCell><Badge className={STATUS_COLORS[r.status] ?? ""}>{r.status.replace(/_/g, " ")}</Badge></TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.created_record_type ?? "—"}</TableCell>
              </TableRow>
            ))}
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
                  <Badge variant="outline">{selected.classification}</Badge>
                  <Badge className={STATUS_COLORS[selected.status] ?? ""}>{selected.status}</Badge>
                  {selected.confidence != null && <Badge variant="outline">{Math.round(selected.confidence * 100)}% conf</Badge>}
                </div>
                <div>
                  <p className="text-muted-foreground">From</p>
                  <p>{selected.from_name ? `${selected.from_name} <${selected.from_addr}>` : selected.from_addr}</p>
                </div>
                {selected.ai_summary && (
                  <Card className="p-3 bg-muted/40">
                    <p className="font-semibold mb-1">AI summary</p>
                    <p>{selected.ai_summary}</p>
                  </Card>
                )}
                {selected.ai_extracted && Object.keys(selected.ai_extracted).length > 0 && (
                  <div>
                    <p className="font-semibold mb-1">Extracted fields</p>
                    <pre className="text-xs bg-muted/40 p-2 rounded overflow-x-auto">{JSON.stringify(selected.ai_extracted, null, 2)}</pre>
                  </div>
                )}
                {(selected.ai_flags as any[])?.length > 0 && (
                  <Card className="p-3 bg-warning/10 border-warning">
                    <p className="font-semibold mb-2">AI flags</p>
                    {(selected.ai_flags as any[]).map((f, i) => (
                      <p key={i} className="text-xs"><strong>{f.field}:</strong> {f.issue} — <em>{f.suggestion}</em></p>
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
                <div className="flex gap-2">
                  <Button variant="outline" onClick={async () => {
                    try {
                      const r = await reclassifyInboundEmail({ data: { id: selected.id } });
                      toast.success(`Reclassified as ${(r as any).classification}`);
                      setSelected(null); load();
                    } catch (e: any) { toast.error(e.message); }
                  }}>Re-classify</Button>
                  <Button variant="outline" onClick={async () => {
                    try {
                      await dismissInboundEmail({ data: { id: selected.id } });
                      toast.success("Dismissed"); setSelected(null); load();
                    } catch (e: any) { toast.error(e.message); }
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
