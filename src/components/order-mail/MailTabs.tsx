import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  useOmMail,
  useOmMailAction,
  useOmMailDetail,
  useOmNeedsReply,
  useOmSetNote,
  useOmTeach,
  useOmTeams,
} from "@/hooks/useOrderMail";
import { ConfirmButton, Empty, Errors, errorsOf, fmt, type Mode } from "./shared";

const STATUSES = ["new", "classified", "filed", "unrouted", "ignored", "error", "needs_review"];
const ALL = "__all";
const pct = (c: unknown) => (c == null ? "—" : `${Math.round(Number(c) * 100)}%`);

function TeamSelect({ value, onChange, placeholder = "Team" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const teams = useOmTeams().data ?? [];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-44 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {teams.filter((t) => t.kind === "team").map((t) => (
          <SelectItem key={t.key} value={t.key}>{t.display_name || t.key}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const shadowNote = "Shadow mode: this records the correction only. Nothing moves on disk or in Outlook.";

function useRunAction(mode: Mode) {
  const act = useOmMailAction();
  return async (v: Parameters<typeof act.mutateAsync>[0]) => {
    try {
      const r = await act.mutateAsync(v);
      const errs = errorsOf(r);
      if (errs.length) return toast.error(errs.join(" "));
      toast.success(`Recorded (mode: ${(r as any)?.mode ?? mode.toLowerCase()})`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
}

function MailActions({ id, mode }: { id: string; mode: Mode }) {
  const run = useRunAction(mode);
  const [team, setTeam] = useState("");
  const [also, setAlso] = useState<string[]>([]);
  const teams = useOmTeams().data ?? [];
  const shadow = mode !== "LIVE";
  const desc = (what: string) => <><p>{what}</p>{shadow && <p className="font-medium">{shadowNote}</p>}</>;
  const lbl = (live: string) => (shadow ? `Record correction: ${live}` : live);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <TeamSelect value={team} onChange={setTeam} placeholder="Wrong team? pick" />
        <ConfirmButton label={lbl("Wrong team?")} disabled={!team} title="Wrong team?" description={desc(`Move to ${team}.`)} onConfirm={() => run({ id, action: "wrong_team", toTeam: team })} />
        <ConfirmButton label={lbl("Restore")} disabled={!team} title="Restore" description={desc(`Restore to ${team}.`)} onConfirm={() => run({ id, action: "restore", toTeam: team })} />
        <ConfirmButton label={lbl("Archive")} title="Archive" description={desc("Mark as ignored / archived.")} onConfirm={() => run({ id, action: "archive" })} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Also file to:</span>
        {teams.filter((t) => t.kind === "team").map((t) => (
          <label key={t.key} className="flex items-center gap-1">
            <Checkbox checked={also.includes(t.key)} onCheckedChange={(c) => setAlso((a) => (c ? [...a, t.key] : a.filter((x) => x !== t.key)))} />
            {t.display_name || t.key}
          </label>
        ))}
        <ConfirmButton label={lbl("Also file")} disabled={!also.length} title="Also file to" description={desc(also.join(", "))} onConfirm={() => run({ id, action: "also_file", teams: also })} />
      </div>
    </div>
  );
}

function NoteEditor({ id, note }: { id: string; note: any }) {
  const save = useOmSetNote();
  const [text, setText] = useState<string>(note?.note ?? "");
  const [reply, setReply] = useState<boolean>(!!note?.needs_reply);
  const [errs, setErrs] = useState<string[]>([]);
  return (
    <div className="space-y-2">
      <Label htmlFor="om-note">Note</Label>
      <Textarea id="om-note" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={reply} onCheckedChange={(c) => setReply(!!c)} /> Needs reply</label>
      <Errors list={errs} />
      <Button size="sm" disabled={save.isPending} onClick={async () => {
        try {
          const r = await save.mutateAsync({ id, text, needs_reply: reply });
          setErrs(errorsOf(r));
          if (!errorsOf(r).length) toast.success("Note saved");
        } catch (e) { setErrs([(e as Error).message]); }
      }}>Save note</Button>
    </div>
  );
}

function MailSheet({ id, mode, onClose }: { id: string | null; mode: Mode; onClose: () => void }) {
  const q = useOmMailDetail(id);
  const d: any = q.data;
  const m = d?.message;
  const dec = d?.decisions?.[0];
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader><SheetTitle>{m?.subject ?? "Email"}</SheetTitle></SheetHeader>
        {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {!m ? <p className="mt-4 text-sm text-muted-foreground">Loading…</p> : (
          <div className="mt-4 space-y-5 text-sm">
            <dl className="grid grid-cols-[8rem_1fr] gap-1">
              <dt className="text-muted-foreground">From</dt><dd>{m.sender_name} &lt;{m.sender_address}&gt;</dd>
              <dt className="text-muted-foreground">Received</dt><dd>{fmt(m.received_at)}</dd>
              <dt className="text-muted-foreground">Status</dt><dd>{m.status}</dd>
              <dt className="text-muted-foreground">Mode</dt><dd>{m.mode}</dd>
            </dl>
            <section>
              <h4 className="mb-1 font-semibold">Decision</h4>
              <dl className="grid grid-cols-[8rem_1fr] gap-1">
                <dt className="text-muted-foreground">Team</dt><dd>{m.team_key ?? "—"}</dd>
                <dt className="text-muted-foreground">Confidence</dt><dd>{pct(m.confidence)}</dd>
                <dt className="text-muted-foreground">Route source</dt><dd>{m.route_source ?? "—"}</dd>
                <dt className="text-muted-foreground">Evidence</dt><dd className="break-words text-xs">{dec?.evidence ? JSON.stringify(dec.evidence) : "—"}</dd>
                <dt className="text-muted-foreground">Ambiguity</dt><dd className="break-words text-xs">{dec?.ambiguity ? JSON.stringify(dec.ambiguity) : "—"}</dd>
              </dl>
            </section>
            <section>
              <h4 className="mb-1 font-semibold">Actions</h4>
              <MailActions id={m.id} mode={mode} />
            </section>
            <section>
              <h4 className="mb-1 font-semibold">Filings</h4>
              {d.filings.length ? d.filings.map((f: any) => <div key={f.id} className="text-xs">{f.kind} · {f.team_key} · {f.status}</div>) : <p className="text-muted-foreground">None</p>}
            </section>
            <section>
              <h4 className="mb-1 font-semibold">History</h4>
              {d.actions.length ? d.actions.map((a: any) => <div key={a.id} className="text-xs">{fmt(a.created_at)} · {a.user_name} · {a.action} {a.to_team ? `→ ${a.to_team}` : ""}</div>) : <p className="text-muted-foreground">None</p>}
            </section>
            <NoteEditor key={m.id} id={m.id} note={d.notes?.[0]} />
            <section>
              <div className="mb-1 flex items-center justify-between">
                <h4 className="font-semibold">Body</h4>
                {d.emlUrl && <Button asChild size="sm" variant="outline"><a href={d.emlUrl}><Download className="mr-1 h-3 w-3" />Download .eml</a></Button>}
              </div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{m.body_text}</pre>
              {m.body_truncated && <p className="text-xs text-muted-foreground">Body truncated — download the .eml for the full message.</p>}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function MailTable({ rows, onOpen, extra }: { rows: any[]; onOpen: (id: string) => void; extra?: (r: any) => React.ReactNode }) {
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Received</TableHead><TableHead>From</TableHead><TableHead>Subject</TableHead><TableHead>Team</TableHead><TableHead>Status</TableHead><TableHead>Confidence</TableHead>{extra && <TableHead>Action</TableHead>}</TableRow></TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} className="cursor-pointer" onClick={() => onOpen(r.id)}>
            <TableCell className="whitespace-nowrap text-xs">{fmt(r.received_at)}</TableCell>
            <TableCell className="text-xs">{r.sender_address}</TableCell>
            <TableCell>{r.subject}</TableCell>
            <TableCell>{r.team_name ?? "—"}</TableCell>
            <TableCell><Badge variant="secondary">{r.status}</Badge></TableCell>
            <TableCell>{pct(r.confidence)}</TableCell>
            {extra && <TableCell onClick={(e) => e.stopPropagation()}>{extra(r)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function MailActivityTab({ mode }: { mode: Mode }) {
  const [f, setF] = useState({ status: "", team: "", q: "", from: "", to: "" });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = useOmMail({ status: f.status || undefined, team: f.team || undefined, q: f.q || undefined, from: f.from || undefined, to: f.to || undefined, page, pageSize: 50 });
  const d: any = q.data;
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setPage(0); };
  const pages = d ? Math.max(1, Math.ceil(d.total / 50)) : 1;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <Select value={f.status || ALL} onValueChange={(v) => set("status", v === ALL ? "" : v)}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="Status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All statuses</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
        </Select>
        <TeamSelect value={f.team} onChange={(v) => set("team", v)} placeholder="All teams" />
        {f.team && <Button size="sm" variant="ghost" onClick={() => set("team", "")}>Clear team</Button>}
        <Input className="h-8 w-56 text-xs" placeholder="Search subject or sender" value={f.q} onChange={(e) => set("q", e.target.value)} />
        <Input className="h-8 w-40 text-xs" type="date" aria-label="From" value={f.from} onChange={(e) => set("from", e.target.value)} />
        <Input className="h-8 w-40 text-xs" type="date" aria-label="To" value={f.to} onChange={(e) => set("to", e.target.value)} />
      </div>
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {!d ? <p className="text-sm text-muted-foreground">Loading…</p> : d.rows.length ? (
        <>
          <MailTable rows={d.rows} onOpen={setOpen} />
          <div className="flex items-center justify-end gap-2 text-xs">
            <span>{d.total} emails · page {page + 1} of {pages}</span>
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </>
      ) : <Empty />}
      <MailSheet id={open} mode={mode} onClose={() => setOpen(null)} />
    </Card>
  );
}

function TeachRow({ row, mode }: { row: any; mode: Mode }) {
  const [team, setTeam] = useState("");
  const teach = useOmTeach();
  const run = useRunAction(mode);
  const shadow = mode !== "LIVE";
  return (
    <div className="flex items-center gap-2">
      <TeamSelect value={team} onChange={setTeam} />
      <ConfirmButton label={shadow ? "Record: teach sender" : "Teach sender"} disabled={!team} title={`Teach ${row.sender_address} → ${team}?`}
        description={shadow ? <p>{"Shadow mode: this is recorded only. Learning is not changed until Order Mail is live."}</p> : <p>Future mail from this sender routes to {team}.</p>}
        onConfirm={async () => {
          try {
            const r = await teach.mutateAsync({ address: row.sender_address, team });
            const e = errorsOf(r);
            if (e.length) toast.error(e.join(" ")); else toast.success(`Recorded (mode: ${(r as any).mode})`);
          } catch (err) { toast.error((err as Error).message); }
        }} />
      <ConfirmButton label={shadow ? "Record: wrong team" : "Wrong team?"} disabled={!team} title="Wrong team?"
        description={<p>{shadow ? shadowNote : `Move to ${team}.`}</p>} onConfirm={() => run({ id: row.id, action: "wrong_team", toTeam: team })} />
    </div>
  );
}

export function UnroutedTab({ mode }: { mode: Mode }) {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = useOmMail({ team: "UNROUTED", page, pageSize: 50 });
  const d: any = q.data;
  return (
    <Card className="space-y-3 p-4">
      {mode !== "LIVE" && <p className="text-xs text-muted-foreground">Shadow mode: teaching and corrections are recorded only.</p>}
      {!d ? <p className="text-sm text-muted-foreground">Loading…</p> : d.rows.length ? (
        <>
          <MailTable rows={d.rows} onOpen={setOpen} extra={(r) => <TeachRow row={r} mode={mode} />} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={(page + 1) * 50 >= d.total} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </>
      ) : <Empty />}
      <MailSheet id={open} mode={mode} onClose={() => setOpen(null)} />
    </Card>
  );
}

export function NeedsReplyTab() {
  const q = useOmNeedsReply();
  const rows: any[] = q.data ?? [];
  return (
    <Card className="p-4">
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {!q.data ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length ? (
        <Table>
          <TableHeader><TableRow><TableHead>Received</TableHead><TableHead>From</TableHead><TableHead>Subject</TableHead><TableHead>Team</TableHead><TableHead>Note</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((r) => (
            <TableRow key={r.ledger_key}><TableCell className="text-xs">{r.received}</TableCell><TableCell className="text-xs">{r.sender}</TableCell><TableCell>{r.subject}</TableCell><TableCell>{r.team_key}</TableCell><TableCell className="max-w-xs whitespace-pre-wrap text-xs">{r.note}</TableCell><TableCell className="text-xs">{r.by_name}</TableCell></TableRow>
          ))}</TableBody>
        </Table>
      ) : <Empty>Nothing waiting for a reply. Notes marked “Needs reply” on an email appear here.</Empty>}
    </Card>
  );
}
