import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  useOmCreateContent,
  useOmCreateInternal,
  useOmCreateMulti,
  useOmDisableContent,
  useOmDisableInternal,
  useOmDisableMulti,
  useOmPreview,
  useOmRules,
} from "@/hooks/useOrderMail";
import { ConfirmButton, Empty, Errors, errorsOf, SourceBadge, type Mode } from "./shared";

const status = (on: boolean) => <Badge variant={on ? "default" : "secondary"}>{on ? "enabled" : "disabled"}</Badge>;

function useSubmit(m: { mutateAsync: (v: any) => Promise<any> }, done: () => void) {
  const [errs, setErrs] = useState<string[]>([]);
  return {
    errs,
    submit: async (v: Record<string, unknown>) => {
      try {
        const r = await m.mutateAsync(v);
        const e = errorsOf(r);
        setErrs(e);
        if (!e.length) { toast.success("Saved"); done(); }
      } catch (err) { setErrs([(err as Error).message]); }
    },
  };
}

function Disable({ label, onConfirm, disabled }: { label: string; onConfirm: () => Promise<unknown>; disabled: boolean }) {
  return (
    <ConfirmButton label="Disable" disabled={disabled} title={`Disable ${label}?`} description={<p>It stops being used for routing. The row is kept.</p>}
      onConfirm={async () => {
        try { const e = errorsOf(await onConfirm()); if (e.length) toast.error(e.join(" ")); else toast.success("Disabled"); }
        catch (err) { toast.error((err as Error).message); }
      }} />
  );
}

export function RulesTab({ mode, isAdmin }: { mode: Mode; isAdmin: boolean }) {
  const q = useOmRules();
  const d: any = q.data;
  const canEdit = isAdmin || mode === "LIVE";
  const reason = canEdit ? null : "In shadow mode only admins can change rules.";
  const dc = useOmDisableContent(), di = useOmDisableInternal(), dm = useOmDisableMulti();
  const [c, setC] = useState({ phrase: "", team: "", scope: "subject", match: "contains", weight: "1", note: "" });
  const [i, setI] = useState({ address: "", team: "", note: "" });
  const [mr, setMr] = useState({ kind: "sender", value: "", teams: "", note: "" });
  const cc = useSubmit(useOmCreateContent(), () => setC({ ...c, phrase: "", note: "" }));
  const ci = useSubmit(useOmCreateInternal(), () => setI({ address: "", team: "", note: "" }));
  const cm = useSubmit(useOmCreateMulti(), () => setMr({ ...mr, value: "", teams: "", note: "" }));
  const preview = useOmPreview();
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const field = (v: string, on: (s: string) => void, ph: string, w = "w-40") => <Input className={`h-8 text-xs ${w}`} placeholder={ph} value={v} disabled={!canEdit} onChange={(e) => on(e.target.value)} />;
  return (
    <div className="space-y-4">
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Content phrases</h3>
        <div className="flex flex-wrap gap-2">
          {field(c.phrase, (v) => setC({ ...c, phrase: v }), "Phrase", "w-56")}
          {field(c.team, (v) => setC({ ...c, team: v }), "Team key")}
          {field(c.scope, (v) => setC({ ...c, scope: v }), "Scope (subject/body/any)")}
          {field(c.match, (v) => setC({ ...c, match: v }), "Match (contains/word/regex)")}
          {field(c.weight, (v) => setC({ ...c, weight: v }), "Weight", "w-20")}
          {field(c.note, (v) => setC({ ...c, note: v }), "Note")}
          <Button size="sm" variant="outline" disabled={!c.phrase || preview.isPending} onClick={() => preview.mutate({ phrase: c.phrase, scope: c.scope, match: c.match })}>Preview</Button>
          <Button size="sm" disabled={!canEdit} onClick={() => cc.submit({ ...c, weight: Number(c.weight) })}>Add phrase</Button>
        </div>
        {preview.data && <p className="text-xs">Scanned {(preview.data as any).scanned} recent emails · matches by team: {JSON.stringify((preview.data as any).byTeam ?? (preview.data as any))}</p>}
        <Errors list={cc.errs} />
        {d.contentRules.length ? (
          <Table><TableHeader><TableRow><TableHead>Phrase</TableHead><TableHead>Team</TableHead><TableHead>Scope</TableHead><TableHead>Match</TableHead><TableHead>Hits</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{d.contentRules.map((r: any) => (
              <TableRow key={r.id}><TableCell>{r.phrase}</TableCell><TableCell>{r.team_key}</TableCell><TableCell>{r.scope}</TableCell><TableCell>{r.match}</TableCell><TableCell>{r.hits ?? 0}</TableCell><TableCell><SourceBadge source={r.source} /></TableCell><TableCell>{status(r.enabled)}</TableCell>
                <TableCell>{r.enabled && <Disable label={`“${r.phrase}”`} disabled={!canEdit} onConfirm={() => dc.mutateAsync({ id: r.id })} />}</TableCell></TableRow>
            ))}</TableBody></Table>
        ) : <Empty>No content phrases.</Empty>}
      </Card>
      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Internal senders</h3>
        <div className="flex flex-wrap gap-2">
          {field(i.address, (v) => setI({ ...i, address: v }), "Address", "w-56")}
          {field(i.team, (v) => setI({ ...i, team: v }), "Team key")}
          {field(i.note, (v) => setI({ ...i, note: v }), "Note")}
          <Button size="sm" disabled={!canEdit} onClick={() => ci.submit(i)}>Add sender</Button>
        </div>
        <Errors list={ci.errs} />
        {d.internalRoutes.length ? (
          <Table><TableHeader><TableRow><TableHead>Address</TableHead><TableHead>Team</TableHead><TableHead>Note</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{d.internalRoutes.map((r: any) => (
              <TableRow key={r.address}><TableCell>{r.address}</TableCell><TableCell>{r.team_key}</TableCell><TableCell>{r.note}</TableCell><TableCell><SourceBadge source={r.source} /></TableCell><TableCell>{status(r.enabled)}</TableCell>
                <TableCell>{r.enabled && <Disable label={r.address} disabled={!canEdit} onConfirm={() => di.mutateAsync({ address: r.address })} />}</TableCell></TableRow>
            ))}</TableBody></Table>
        ) : <Empty>No internal senders.</Empty>}
      </Card>
      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Multi-folder</h3>
        <div className="flex flex-wrap gap-2">
          {field(mr.kind, (v) => setMr({ ...mr, kind: v }), "Kind (sender/domain/phrase)")}
          {field(mr.value, (v) => setMr({ ...mr, value: v }), "Value", "w-56")}
          {field(mr.teams, (v) => setMr({ ...mr, teams: v }), "Teams, comma separated", "w-56")}
          {field(mr.note, (v) => setMr({ ...mr, note: v }), "Note")}
          <Button size="sm" disabled={!canEdit} onClick={() => cm.submit({ ...mr, teams: mr.teams.split(",").map((s) => s.trim()).filter(Boolean) })}>Add rule</Button>
        </div>
        <Errors list={cm.errs} />
        {d.multiRoutes.length ? (
          <Table><TableHeader><TableRow><TableHead>Kind</TableHead><TableHead>Value</TableHead><TableHead>Teams</TableHead><TableHead>Hits</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{d.multiRoutes.map((r: any) => (
              <TableRow key={r.id}><TableCell>{r.kind}</TableCell><TableCell>{r.value}</TableCell><TableCell>{(r.team_keys ?? []).join(", ")}</TableCell><TableCell>{r.hits ?? 0}</TableCell><TableCell><SourceBadge source={r.source} /></TableCell><TableCell>{status(r.enabled)}</TableCell>
                <TableCell>{r.enabled && <Disable label={r.value} disabled={!canEdit} onConfirm={() => dm.mutateAsync({ id: r.id })} />}</TableCell></TableRow>
            ))}</TableBody></Table>
        ) : <Empty>No multi-folder rules.</Empty>}
      </Card>
    </div>
  );
}
