import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Save, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useRepContacts, useSaveRepContact, useRematchRepEmails } from "@/hooks/useSalesReports";
import { isValidEmail } from "@/lib/sales-report-email";

type Row = { rep_code: string; rep_name: string | null; email: string | null; cc_emails: string[] | null; send_enabled: boolean; notes: string | null };

export function RepEmailsPanel({ canEdit }: { canEdit: boolean }) {
  const q = useRepContacts();
  const [filter, setFilter] = useState("");
  const rematch = useRematchRepEmails();
  const rows = (q.data?.contacts ?? []) as Row[];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? rows.filter((r) => `${r.rep_code} ${r.rep_name} ${r.email}`.toLowerCase().includes(f)) : rows;
  }, [rows, filter]);
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-semibold">Rep emails</div>
          <div className="text-xs text-muted-foreground">Where each rep's own report goes. House accounts: turn Send off or type the email to use.</div>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button size="sm" variant="outline" disabled={rematch.isPending} title="Fills only empty emails, by P21 contact name"
              onClick={() => rematch.mutate(undefined, { onSuccess: (r: any) => toast.success(`Filled ${r.filled} email(s) from P21`), onError: (e: any) => toast.error(e?.message ?? "Re-match failed") })}>
              <RefreshCw className={`w-3 h-3 mr-1 ${rematch.isPending ? "animate-spin" : ""}`} />Re-match from P21
            </Button>
          )}
          <Input className="max-w-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>Rep code</TableHead><TableHead>Name</TableHead><TableHead>Email</TableHead>
          <TableHead>CC (comma-separated)</TableHead><TableHead>Send</TableHead><TableHead>Notes</TableHead><TableHead />
        </TableRow></TableHeader>
        <TableBody>
          {shown.map((r) => <ContactRow key={r.rep_code} row={r} canEdit={canEdit} />)}
          {!shown.length && <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-6">{q.isLoading ? "Loading…" : "No reps"}</TableCell></TableRow>}
        </TableBody>
      </Table>
    </Card>
  );
}

function ContactRow({ row, canEdit }: { row: Row; canEdit: boolean }) {
  const save = useSaveRepContact();
  const [email, setEmail] = useState(row.email ?? "");
  const [cc, setCc] = useState((row.cc_emails ?? []).join(", "));
  const [on, setOn] = useState(row.send_enabled);
  const [notes, setNotes] = useState(row.notes ?? "");
  useEffect(() => { setEmail(row.email ?? ""); setCc((row.cc_emails ?? []).join(", ")); setOn(row.send_enabled); setNotes(row.notes ?? ""); }, [row]);
  const ccList = cc.split(",").map((s) => s.trim()).filter(Boolean);
  const emailBad = !!email.trim() && !isValidEmail(email);
  const ccBad = ccList.some((e) => !isValidEmail(e));
  const dirty = email !== (row.email ?? "") || cc !== (row.cc_emails ?? []).join(", ") || on !== row.send_enabled || notes !== (row.notes ?? "");
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.rep_code}</TableCell>
      <TableCell className="text-sm">{row.rep_name}</TableCell>
      <TableCell><Input disabled={!canEdit} value={email} onChange={(e) => setEmail(e.target.value)} className={emailBad ? "border-destructive" : ""} placeholder="No email" /></TableCell>
      <TableCell><Input disabled={!canEdit} value={cc} onChange={(e) => setCc(e.target.value)} className={ccBad ? "border-destructive" : ""} /></TableCell>
      <TableCell><Switch disabled={!canEdit} checked={on} onCheckedChange={setOn} /></TableCell>
      <TableCell><Input disabled={!canEdit} value={notes} onChange={(e) => setNotes(e.target.value)} /></TableCell>
      <TableCell>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={!dirty || emailBad || ccBad || save.isPending}
            onClick={() => save.mutate({ rep_code: row.rep_code, email: email.trim() || null, cc_emails: ccList, send_enabled: on, notes: notes.trim() || null }, {
              onSuccess: () => toast.success(`Saved ${row.rep_code}`), onError: (e: any) => toast.error(e?.message ?? "Save failed"),
            })}>
            <Save className="w-3 h-3" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
