import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  useOmForget,
  useOmImport,
  useOmLearned,
  useOmSettings,
  useOmUpdateMailbox,
  useOmUpdateSettings,
} from "@/hooks/useOrderMail";
import { ConfirmButton, Empty, Errors, errorsOf, fmt, SourceBadge } from "./shared";

export function LearningTab({ isAdmin }: { isAdmin: boolean }) {
  const [text, setText] = useState("");
  const [bucket, setBucket] = useState<"all" | "sender" | "domain">("all");
  const q = useOmLearned({ q: text, bucket: bucket === "all" ? undefined : bucket, limit: 200 });
  const forget = useOmForget();
  const rows: any[] = q.data ?? [];
  return (
    <Card className="space-y-3 p-4">
      <div className="flex gap-2">
        <Input className="h-8 w-64 text-xs" placeholder="Search sender or domain" value={text} onChange={(e) => setText(e.target.value)} />
        <Select value={bucket} onValueChange={(v) => setBucket(v as typeof bucket)}>
          <SelectTrigger className="h-8 w-36 text-xs" aria-label="Bucket"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="sender">Senders</SelectItem><SelectItem value="domain">Domains</SelectItem></SelectContent>
        </Select>
        <span className="self-center text-xs text-muted-foreground">Showing up to 200</span>
      </div>
      {!q.data ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length ? (
        <Table>
          <TableHeader><TableRow><TableHead>Bucket</TableHead><TableHead>Key</TableHead><TableHead>Team</TableHead><TableHead>Count</TableHead><TableHead>Source</TableHead><TableHead>Last</TableHead>{isAdmin && <TableHead />}</TableRow></TableHeader>
          <TableBody>{rows.map((r) => (
            <TableRow key={`${r.bucket}:${r.key}`}>
              <TableCell>{r.bucket}</TableCell><TableCell>{r.key}</TableCell><TableCell>{r.team_key}</TableCell><TableCell>{r.count}</TableCell>
              <TableCell>{r.source === "forgotten" ? "forgotten" : <SourceBadge source={r.source === "web" || r.source === "taught" ? "web" : "desktop"} />}</TableCell>
              <TableCell className="text-xs">{r.last_at}</TableCell>
              {isAdmin && <TableCell>{r.source !== "forgotten" && (
                <ConfirmButton label="Forget" title={`Forget ${r.key}?`} description={<p>It stops being used for routing, and a desktop re-import will not bring it back.</p>}
                  onConfirm={async () => {
                    try { const e = errorsOf(await forget.mutateAsync({ bucket: r.bucket, key: r.key })); if (e.length) toast.error(e.join(" ")); else toast.success("Forgotten"); }
                    catch (err) { toast.error((err as Error).message); }
                  }} />
              )}</TableCell>}
            </TableRow>
          ))}</TableBody>
        </Table>
      ) : <Empty>No learned senders match.</Empty>}
    </Card>
  );
}

const BOOL_KEYS = ["filing_enabled", "paused", "learning_enabled", "ledger_sync_enabled"] as const;
const TEXT_KEYS = ["processed_category", "own_domains", "content_only_senders"] as const;

export function SettingsTab({ mailboxes }: { mailboxes: any[] }) {
  const q = useOmSettings(true);
  const save = useOmUpdateSettings();
  const [form, setForm] = useState<Record<string, any>>({});
  const [errs, setErrs] = useState<string[]>([]);
  useEffect(() => {
    if (q.data) {
      const s: any = q.data;
      setForm({
        mode: s.mode ?? "shadow",
        retention_days: s.retention_days ?? 90,
        processed_marker: s.processed_marker ?? "none",
        ignore_subject_patterns: Array.isArray(s.ignore_subject_patterns) ? s.ignore_subject_patterns.join("\n") : (s.ignore_subject_patterns ?? ""),
        ...Object.fromEntries(BOOL_KEYS.map((k) => [k, s[k] === true])),
        ...Object.fromEntries(TEXT_KEYS.map((k) => [k, s[k] ?? ""])),
      });
    }
  }, [q.data]);
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Order Mail settings</h3>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center gap-2"><Switch id="om-mode" checked={form.mode === "live"} onCheckedChange={(c) => set("mode", c ? "live" : "shadow")} /><Label htmlFor="om-mode">Mode: {form.mode}</Label></div>
          {BOOL_KEYS.map((k) => <div key={k} className="flex items-center gap-2"><Switch id={`om-${k}`} checked={!!form[k]} onCheckedChange={(c) => set(k, c)} /><Label htmlFor={`om-${k}`}>{k}</Label></div>)}
          <div><Label htmlFor="om-ret">retention_days</Label><Input id="om-ret" type="number" className="h-8 text-xs" value={form.retention_days ?? ""} onChange={(e) => set("retention_days", Number(e.target.value))} /></div>
          <div><Label>processed_marker</Label>
            <Select value={form.processed_marker ?? "none"} onValueChange={(v) => set("processed_marker", v)}>
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{["flag", "category", "both", "none"].map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
            </Select></div>
          {TEXT_KEYS.map((k) => <div key={k}><Label htmlFor={`om-${k}`}>{k}</Label><Input id={`om-${k}`} className="h-8 text-xs" value={form[k] ?? ""} onChange={(e) => set(k, e.target.value)} /></div>)}
          <div className="md:col-span-2"><Label htmlFor="om-isp">ignore_subject_patterns (one per line)</Label><Textarea id="om-isp" value={form.ignore_subject_patterns ?? ""} onChange={(e) => set("ignore_subject_patterns", e.target.value)} /></div>
        </div>
        <Errors list={errs} />
        <ConfirmButton variant="default" label="Save settings" title="Save Order Mail settings?" description={<p>The server checks every value; switching to live is refused until the mailbox and file agent are ready.</p>}
          onConfirm={async () => {
            try { const r = await save.mutateAsync(form); const e = errorsOf(r); setErrs(e); if (!e.length) toast.success("Settings saved"); }
            catch (err) { setErrs([(err as Error).message]); }
          }} />
      </Card>
      {mailboxes.map((m) => <MailboxCard key={m.id} m={m} />)}
      <ImportCard />
    </div>
  );
}

function MailboxCard({ m }: { m: any }) {
  const upd = useOmUpdateMailbox();
  const [enabled, setEnabled] = useState<boolean>(!!m.enabled);
  const [start, setStart] = useState<string>(m.start_at ? String(m.start_at).slice(0, 16) : "");
  const [errs, setErrs] = useState<string[]>([]);
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Mailbox {m.mailbox}</h3>
      <p className="text-xs text-muted-foreground">Last sweep {fmt(m.last_sweep_at)}</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2"><Switch id={`mb-${m.id}`} checked={enabled} onCheckedChange={setEnabled} /><Label htmlFor={`mb-${m.id}`}>Enabled</Label></div>
        <div className="flex items-center gap-2"><Label htmlFor={`mbs-${m.id}`}>Start at</Label><Input id={`mbs-${m.id}`} type="datetime-local" className="h-8 w-56 text-xs" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <ConfirmButton label="Save mailbox" title="Save mailbox?" description={<p>{enabled ? "Enabling lets the next sweep read this mailbox." : "The mailbox will not be swept."}</p>}
          onConfirm={async () => {
            try { const r = await upd.mutateAsync({ id: m.id, enabled, start_at: start ? new Date(start).toISOString() : null }); const e = errorsOf(r); setErrs(e); if (!e.length) toast.success("Mailbox saved"); }
            catch (err) { setErrs([(err as Error).message]); }
          }} />
      </div>
      <Errors list={errs} />
    </Card>
  );
}

function ImportCard() {
  const imp = useOmImport();
  const [files, setFiles] = useState<Array<{ name: string; text: string }>>([]);
  const [remove, setRemove] = useState("");
  const [check, setCheck] = useState<any>(null);
  const [errs, setErrs] = useState<string[]>([]);
  const payload = (apply: boolean) => ({ files, apply, removeLearned: remove.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
  const run = async (apply: boolean) => {
    try {
      const r = await imp.mutateAsync(payload(apply));
      const e = errorsOf(r);
      setErrs(e);
      if (!e.length) { setCheck(r); if (apply) toast.success("Import applied"); }
    } catch (err) { setErrs([(err as Error).message]); }
  };
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold">Import from desktop</h3>
      <Input type="file" multiple aria-label="Desktop files" onChange={async (e) => {
        const list = Array.from(e.target.files ?? []);
        setFiles(await Promise.all(list.map(async (f) => ({ name: f.name, text: await f.text() }))));
        setCheck(null);
      }} />
      <div><Label htmlFor="om-rm">Remove learned (one per line, sender:x@y.com or domain:y.com)</Label><Textarea id="om-rm" value={remove} onChange={(e) => setRemove(e.target.value)} /></div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!files.length || imp.isPending} onClick={() => run(false)}>Check</Button>
        <ConfirmButton variant="default" label="Apply" disabled={!check || check.applied} title="Apply desktop import?" description={<p>Writes the checked teams, rules and learning. Web-edited rules are kept.</p>} onConfirm={() => run(true)} />
      </div>
      <Errors list={errs} />
      {check && (
        <div className="text-xs">
          <pre className="whitespace-pre-wrap rounded bg-muted p-2">{JSON.stringify(check.counts, null, 2)}</pre>
          {check.warnings?.length ? <ul className="text-warning-text">{check.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul> : <p>No warnings.</p>}
        </div>
      )}
    </Card>
  );
}
