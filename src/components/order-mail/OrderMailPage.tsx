import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { AlertTriangle, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useOmOverview, useOmProbe, useOmShadow, useOmSweepNow } from "@/hooks/useOrderMail";
import { versionAtLeast, LIVE_MIN_AGENT_VERSION } from "@/lib/archiver/order-mail.shared";
import { ConfirmButton, Empty, fmt, type Mode } from "./shared";
import { MailActivityTab, NeedsReplyTab, UnroutedTab } from "./MailTabs";
import { RulesTab } from "./RulesTab";
import { LearningTab, SettingsTab } from "./AdminTabs";

export const SHADOW_TEXT =
  "Shadow mode — Order Mail is sorting mail on paper only. Nothing is filed or changed in Outlook. The desktop archiver is still doing the filing.";

export function modeOf(s: { paused?: boolean; effective_mode?: string } | undefined): Mode {
  if (s?.paused) return "PAUSED";
  return s?.effective_mode === "live" ? "LIVE" : "SHADOW";
}

function ModeBanner({ ov }: { ov: any }) {
  const mode = modeOf(ov?.settings);
  const version: string | null = ov?.bridge?.agents?.[0]?.version ?? null;
  const cls =
    mode === "LIVE"
      ? "border-success/40 bg-success/10"
      : mode === "PAUSED"
        ? "border-border bg-muted"
        : "border-warning/50 bg-warning/10";
  const badge =
    mode === "LIVE"
      ? "bg-success text-success-foreground"
      : mode === "PAUSED"
        ? "bg-muted-foreground text-background"
        : "bg-warning text-warning-foreground";
  return (
    <div className="mb-4 space-y-2">
      <div className={`flex items-start gap-3 rounded-md border p-3 text-sm ${cls}`}>
        <Badge className={badge}>{mode}</Badge>
        <span>
          {mode === "SHADOW"
            ? SHADOW_TEXT
            : mode === "LIVE"
              ? "Live — Order Mail files mail and applies corrections."
              : "Paused — Order Mail is not sweeping the mailbox."}
        </span>
      </div>
      {ov && ov.settings?.graph_configured === false && (
        <div className="flex items-center gap-2 rounded-md border p-2 text-sm text-muted-foreground">
          <PlugZap className="h-4 w-4" aria-hidden /> Not connected to the mailbox yet.
        </div>
      )}
      {ov && !versionAtLeast(version, LIVE_MIN_AGENT_VERSION) && (
        <div className="flex items-center gap-2 rounded-md border p-2 text-sm text-warning-text">
          <AlertTriangle className="h-4 w-4" aria-hidden /> File agent needs update to{" "}
          {LIVE_MIN_AGENT_VERSION} (installed: {version ?? "unknown"}).
        </div>
      )}
    </div>
  );
}

function Counts({ title, map }: { title: string; map: Record<string, number> | undefined }) {
  const entries = Object.entries(map ?? {});
  return (
    <Card className="p-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {entries.length ? (
        <ul className="space-y-1 text-sm">
          {entries.map(([k, n]) => (
            <li key={k} className="flex justify-between">
              <span>{k}</span>
              <span className="tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None</p>
      )}
    </Card>
  );
}

function OverviewTab({ ov, isAdmin }: { ov: any; isAdmin: boolean }) {
  const sweep = useOmSweepNow();
  const probe = useOmProbe();
  if (!ov) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const agent = ov.bridge?.agents?.[0];
  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex gap-2">
          <ConfirmButton
            label="Sweep now"
            title="Run a mailbox sweep now?"
            description={<p>Runs one sweep in the current mode. In shadow mode nothing is filed.</p>}
            onConfirm={async () => {
              try {
                await sweep.mutateAsync();
                toast.success("Sweep finished");
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          />
          <ConfirmButton
            label="Check archive folder"
            title="Check the archive folder?"
            description={<p>Queues one read-only probe job for the file agent (reuses an open one).</p>}
            onConfirm={async () => {
              try {
                const r: any = await probe.mutateAsync();
                toast.success(r?.existing ? "A probe is already waiting" : "Probe queued");
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4"><div className="text-xs text-muted-foreground">Today (Chicago)</div><div className="text-2xl font-bold">{ov.today.total}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">Unrouted</div><div className="text-2xl font-bold">{ov.unrouted}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">Needs reply</div><div className="text-2xl font-bold">{ov.needsReply}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted-foreground">Open filings</div><div className="text-2xl font-bold">{Object.values(ov.openFilings ?? {}).reduce((a: number, b) => a + Number(b), 0)}</div></Card>
      </div>
      {ov.today.total === 0 && <Card><Empty /></Card>}
      <div className="grid gap-3 md:grid-cols-3">
        <Counts title="Today by team" map={ov.today.byTeam} />
        <Counts title="Today by status" map={ov.today.byStatus} />
        <Counts title="Open filings by status" map={ov.openFilings} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {(ov.mailboxes.length ? ov.mailboxes : [null]).map((m: any, i: number) => (
          <Card key={m?.id ?? i} className="p-4 text-sm">
            <h3 className="mb-2 font-semibold">Mailbox</h3>
            {m ? (
              <dl className="grid grid-cols-[8rem_1fr] gap-1">
                <dt className="text-muted-foreground">Address</dt><dd>{m.mailbox}</dd>
                <dt className="text-muted-foreground">Enabled</dt><dd>{m.enabled ? "Yes" : "No"}</dd>
                <dt className="text-muted-foreground">Last sweep</dt><dd>{fmt(m.last_sweep_at)}</dd>
                <dt className="text-muted-foreground">Last error</dt><dd>{m.last_error ?? "—"}</dd>
                <dt className="text-muted-foreground">Start at</dt><dd>{fmt(m.start_at)}</dd>
              </dl>
            ) : (
              <p className="text-muted-foreground">No mailbox configured.</p>
            )}
          </Card>
        ))}
        <Card className="p-4 text-sm">
          <h3 className="mb-2 font-semibold">File agent</h3>
          <dl className="grid grid-cols-[8rem_1fr] gap-1">
            <dt className="text-muted-foreground">Name</dt><dd>{agent?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">Version</dt><dd>{agent?.version ?? "—"}</dd>
            <dt className="text-muted-foreground">Last seen</dt><dd>{fmt(agent?.last_seen_at)}</dd>
            <dt className="text-muted-foreground">Archive probe</dt><dd>{ov.probeJob?.status ?? "none"}</dd>
          </dl>
        </Card>
      </div>
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Last 10 runs</h3>
        {ov.runs.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Trigger</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead>Counts</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
            <TableBody>
              {ov.runs.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>{fmt(r.started_at)}</TableCell><TableCell>{r.trigger}</TableCell><TableCell>{r.mode}</TableCell><TableCell>{r.status}</TableCell>
                  <TableCell className="text-xs">{r.counts ? JSON.stringify(r.counts) : "—"}</TableCell>
                  <TableCell className="text-xs text-destructive">{r.error ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty>No sweeps have run yet.</Empty>
        )}
      </Card>
    </div>
  );
}

export const GATE_PCT = 98;
export const GATE_MIN = 500;
export function gateMet(r: { compared: number; agreed: number; humanCorrected: { desktopOnlyRight: number } }) {
  const pct = r.compared ? (r.agreed / r.compared) * 100 : 0;
  return r.compared >= GATE_MIN && pct >= GATE_PCT && r.humanCorrected.desktopOnlyRight === 0;
}

function HealthTab() {
  const q = useOmShadow();
  const r: any = q.data;
  if (!r) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const pct = r.compared ? ((r.agreed / r.compared) * 100).toFixed(1) : "—";
  const met = gateMet(r);
  return (
    <div className="space-y-4">
      <Card className="p-4 text-sm">
        <p>Agreement is measured against the desktop archiver's own filing log. Go-live gate: 98% agreement over at least 500 emails and zero wrong-team results the desktop got right.</p>
        <div className="mt-2 font-semibold">
          Gate: <Badge className={met ? "bg-success text-success-foreground" : "bg-muted-foreground text-background"}>{met ? "met" : "not met"}</Badge>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[["Compared", r.compared], ["Agreed", r.agreed], ["Disagreed", r.disagreed], ["Agreement", pct === "—" ? pct : `${pct}%`], ["Human-corrected", r.humanCorrected.total], ["Web was right", r.humanCorrected.webRight], ["Desktop was right", r.humanCorrected.desktopRight], ["Desktop right, web wrong", r.humanCorrected.desktopOnlyRight], ["No desktop result yet", r.noDesktopYet]].map(([l, v]) => (
          <Card key={l as string} className="p-4"><div className="text-xs text-muted-foreground">{l}</div><div className="text-2xl font-bold">{v}</div></Card>
        ))}
      </div>
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Disagreements (up to 50)</h3>
        {r.disagreements.length ? (
          <Table>
            <TableHeader><TableRow><TableHead>Subject</TableHead><TableHead>Sender</TableHead><TableHead>Web</TableHead><TableHead>Desktop</TableHead><TableHead>Source</TableHead><TableHead>Confidence</TableHead></TableRow></TableHeader>
            <TableBody>
              {r.disagreements.map((d: any) => (
                <TableRow key={d.id}><TableCell>{d.subject}</TableCell><TableCell>{d.sender}</TableCell><TableCell>{d.web_team}</TableCell><TableCell>{d.desktop_team}</TableCell><TableCell>{d.route_source}</TableCell><TableCell>{d.confidence == null ? "—" : `${Math.round(Number(d.confidence) * 100)}%`}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty />
        )}
      </Card>
    </div>
  );
}

export function OrderMailPage() {
  const { hasAnyRole, hasRole } = useAuth();
  const canView = hasAnyRole(["admin", "ops_orders"]);
  const isAdmin = hasRole("admin");
  const ov = useOmOverview();
  if (!canView) {
    return (
      <div className="p-6">
        <ModuleHeader title="Order Mail" description="Orders access required." />
        <Card className="p-6 text-sm text-muted-foreground">You need the Admin or Orders role to view Order Mail.</Card>
      </div>
    );
  }
  const mode = modeOf(ov.data?.settings);
  return (
    <div>
      <ModuleHeader title="Order Mail" description="Sorts the shared order mailbox into team folders, with a review trail." />
      <ModeBanner ov={ov.data} />
      {ov.isError && <p className="mb-3 text-sm text-destructive">{(ov.error as Error).message}</p>}
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Mail Activity</TabsTrigger>
          <TabsTrigger value="unrouted">Unrouted &amp; Teach</TabsTrigger>
          <TabsTrigger value="reply">Needs reply</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="learning">Learning</TabsTrigger>
          <TabsTrigger value="health">Health</TabsTrigger>
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="overview"><OverviewTab ov={ov.data} isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="activity"><MailActivityTab mode={mode} /></TabsContent>
        <TabsContent value="unrouted"><UnroutedTab mode={mode} /></TabsContent>
        <TabsContent value="reply"><NeedsReplyTab /></TabsContent>
        <TabsContent value="rules"><RulesTab mode={mode} isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="learning"><LearningTab isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="health"><HealthTab /></TabsContent>
        {isAdmin && <TabsContent value="settings"><SettingsTab mailboxes={ov.data?.mailboxes ?? []} /></TabsContent>}
      </Tabs>
    </div>
  );
}
