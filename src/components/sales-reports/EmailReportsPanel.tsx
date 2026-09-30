import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useEmailSendList, usePreviewEmails, useSendEmails, useSalesReportRuns } from "@/hooks/useSalesReports";
import { SKIP_LABEL, type PlannedSend, type PlannedSkip } from "@/lib/sales-report-email";

type Rep = { rep_code: string; rep_name: string | null; rows: number; status: string; email: string | null; send_enabled: boolean; last_sent_at: string | null; last_sent_to: string | null };

export function EmailReportsPanel() {
  const runs = useSalesReportRuns();
  const doneRuns = ((runs.data?.runs ?? []) as any[]).filter((r) => r.status === "done");
  const [runId, setRunId] = useState<string | null>(null);
  const list = useEmailSendList(runId);
  const run = list.data?.run;
  const reps = (list.data?.reps ?? []) as Rep[];
  const [hideNoActivity, setHideNoActivity] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendAgain, setSendAgain] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [preview, setPreview] = useState<{ send: PlannedSend[]; skipped: PlannedSkip[] } | null>(null);
  const [results, setResults] = useState<any[] | null>(null);
  const previewFn = usePreviewEmails();
  const sendFn = useSendEmails();

  const visible = useMemo(() => reps.filter((r) => !hideNoActivity || r.status !== "no_activity"), [reps, hideNoActivity]);
  const selectedAlreadySent = reps.filter((r) => selected.has(r.rep_code) && r.last_sent_at);
  const toggle = (c: string, v: boolean) => setSelected((s) => { const n = new Set(s); v ? n.add(c) : n.delete(c); return n; });

  function openPreview() {
    if (!run) return;
    previewFn.mutate({ runId: run.id, repCodes: [...selected], sendAgain, testMode }, {
      onSuccess: (p: any) => { setResults(null); setPreview(p); },
      onError: (e: any) => toast.error(e?.message ?? "Preview failed"),
    });
  }
  function confirmSend() {
    if (!run || !preview) return;
    const expectedRows = Object.fromEntries(preview.send.map((s) => [s.rep_code, s.rows]));
    sendFn.mutate({ runId: run.id, repCodes: preview.send.map((s) => s.rep_code), sendAgain, testMode, expectedRows }, {
      onSuccess: (r: any) => {
        setResults(r.results);
        const sent = r.results.filter((x: any) => x.status === "sent").length;
        const failed = r.results.filter((x: any) => x.status === "failed").length;
        failed ? toast.error(`${sent} sent, ${failed} failed`) : toast.success(`${sent} sent`);
      },
      onError: (e: any) => toast.error(e?.message ?? "Send failed"),
    });
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-semibold flex items-center gap-2"><Mail className="w-4 h-4" /> Email reports</div>
          <div className="text-xs text-muted-foreground">One email per rep, containing only that rep's report.</div>
        </div>
        <div className="min-w-64">
          <Label className="text-xs text-muted-foreground">Run</Label>
          <Select value={runId ?? "latest"} onValueChange={(v) => { setRunId(v === "latest" ? null : v); setSelected(new Set()); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Latest done run</SelectItem>
              {doneRuns.map((r) => <SelectItem key={r.id} value={r.id}>{r.period_year}-{String(r.period_month).padStart(2, "0")} · {new Date(r.run_at).toLocaleString()}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Button size="sm" variant="outline" onClick={() => setSelected(new Set(visible.map((r) => r.rep_code)))}>Select all</Button>
        <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>Select none</Button>
        <label className="flex items-center gap-2"><Switch checked={hideNoActivity} onCheckedChange={setHideNoActivity} /> Hide no-activity reps</label>
        <label className="flex items-center gap-2"><Switch checked={testMode} onCheckedChange={setTestMode} /> Send to me instead (test)</label>
        {selectedAlreadySent.length > 0 && !testMode && (
          <label className="flex items-center gap-2 text-destructive"><Checkbox checked={sendAgain} onCheckedChange={(v) => setSendAgain(!!v)} />
            Send again ({selectedAlreadySent.length} already sent for this run)</label>
        )}
        <span className="text-muted-foreground">{selected.size} selected</span>
        <Button size="sm" disabled={!selected.size || previewFn.isPending} onClick={openPreview}>
          {previewFn.isPending && <Loader2 className="w-3 h-3 mr-2 animate-spin" />}Preview
        </Button>
      </div>

      <Table>
        <TableHeader><TableRow>
          <TableHead /><TableHead>Name</TableHead><TableHead>Rep code</TableHead><TableHead className="text-right">Rows</TableHead>
          <TableHead>Status</TableHead><TableHead>Email</TableHead><TableHead>Last sent (this run)</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {visible.map((r) => (
            <TableRow key={r.rep_code}>
              <TableCell><Checkbox checked={selected.has(r.rep_code)} onCheckedChange={(v) => toggle(r.rep_code, !!v)} /></TableCell>
              <TableCell className="text-sm">{r.rep_name}</TableCell>
              <TableCell className="font-mono text-xs">{r.rep_code}</TableCell>
              <TableCell className="text-right">{r.rows}</TableCell>
              <TableCell><Badge variant={r.status === "ok" ? "secondary" : "outline"}>{r.status === "ok" ? "ok" : "no activity"}</Badge></TableCell>
              <TableCell className="text-xs">{r.email ?? <span className="text-muted-foreground">No email</span>}{!r.send_enabled && <Badge variant="outline" className="ml-2">Send off</Badge>}</TableCell>
              <TableCell className="text-xs">{r.last_sent_at ? `${new Date(r.last_sent_at).toLocaleString()} → ${r.last_sent_to}` : "—"}</TableCell>
            </TableRow>
          ))}
          {!visible.length && <TableRow><TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-6">{list.isLoading ? "Loading…" : "No reps on this run"}</TableCell></TableRow>}
        </TableBody>
      </Table>

      <Dialog open={!!preview} onOpenChange={(o) => !o && !sendFn.isPending && setPreview(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{testMode ? "[TEST] " : ""}Preview — {preview?.send.length ?? 0} email(s)</DialogTitle></DialogHeader>
          {preview && (
            <div className="space-y-4 text-sm">
              <Table>
                <TableHeader><TableRow><TableHead>Rep</TableHead><TableHead>To / CC</TableHead><TableHead>Attachment</TableHead><TableHead className="text-right">Rows</TableHead>{results && <TableHead>Result</TableHead>}</TableRow></TableHeader>
                <TableBody>{preview.send.map((s) => {
                  const res = results?.find((x) => x.rep_code === s.rep_code);
                  return (
                    <TableRow key={s.rep_code}>
                      <TableCell>{s.rep_name} <span className="font-mono text-xs text-muted-foreground">{s.rep_code}</span></TableCell>
                      <TableCell className="text-xs">{s.to}{s.cc.length ? ` · cc ${s.cc.join(", ")}` : ""}</TableCell>
                      <TableCell className="font-mono text-xs">{s.attachment}</TableCell>
                      <TableCell className="text-right">{s.rows}</TableCell>
                      {results && <TableCell><Badge variant={res?.status === "sent" ? "default" : "destructive"}>{res?.status ?? "—"}</Badge> <span className="text-xs">{res?.status === "failed" ? res.detail : ""}</span></TableCell>}
                    </TableRow>
                  );
                })}</TableBody>
              </Table>
              {preview.skipped.length > 0 && (
                <div>
                  <div className="font-medium mb-1">Will be skipped ({preview.skipped.length})</div>
                  <ul className="text-xs space-y-0.5">{preview.skipped.map((s) => <li key={s.rep_code}>{s.rep_name} ({s.rep_code}) — {SKIP_LABEL[s.reason]}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={sendFn.isPending} onClick={() => setPreview(null)}>{results ? "Close" : "Cancel"}</Button>
            {!results && (
              <Button disabled={!preview?.send.length || sendFn.isPending} onClick={confirmSend}>
                {sendFn.isPending && <Loader2 className="w-3 h-3 mr-2 animate-spin" />}
                {testMode ? `Send ${preview?.send.length ?? 0} test emails to me` : `Send ${preview?.send.length ?? 0} emails`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
