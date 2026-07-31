import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { KpiCard } from "@/components/shared/KpiCard";
import { AlertTriangle, BellOff, ChevronDown, Loader2, Play, Plus, Trash2, Bell } from "lucide-react";
import {
  useCapacityAlertRules, useSaveCapacityAlertRule, useDeleteCapacityAlertRule,
  useEvaluateCapacityAlerts, useCapacityAlertLog, useCapacityAlerts,
  useSetCapacityAlertStatus, useCapacityAlertPrefs, useSaveCapacityAlertPref,
  useCapacityAlertSettings, useSaveCapacityAlertSettings,
} from "@/hooks/useCapacityAlerts";

type RouteRow = { id: string; code: string; name: string; hub: string };

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(Number(v) * 100)}%`);

const EMPTY_RULE = {
  id: undefined as string | undefined,
  name: "",
  threshold_pct: 75,
  consecutive_days: 3,
  scope: "all" as "all" | "routes",
  route_codes: [] as string[],
  active: true,
  cooldown_days: 7,
  channels: ["in_app", "email"] as Array<"in_app" | "email">,
  owner_label: "",
  manager_digest: true,
  lookback_days: 14,
};

/**
 * "Alerts" tab: rule CRUD, dry-run evaluation preview, per-rep governance,
 * the evaluation audit log, and the fired-alert list with rep attribution.
 */
export function AlertsTab({ routes, isManager }: { routes: RouteRow[]; isManager: boolean }) {
  const rules = useCapacityAlertRules(isManager);
  const saveRule = useSaveCapacityAlertRule();
  const delRule = useDeleteCapacityAlertRule();
  const evaluate = useEvaluateCapacityAlerts();
  const log = useCapacityAlertLog(isManager);
  const alerts = useCapacityAlerts("all");
  const setStatus = useSetCapacityAlertStatus();

  const [draft, setDraft] = useState<typeof EMPTY_RULE | null>(null);
  const [preview, setPreview] = useState<any | null>(null);

  const alertRows = (alerts.data?.alerts ?? []) as any[];
  const openCount = alertRows.filter((a) => a.status === "new").length;

  async function onSaveRule() {
    if (!draft) return;
    if (!draft.name.trim()) { toast.error("Give the rule a name"); return; }
    try {
      await saveRule.mutateAsync({
        ...draft,
        name: draft.name.trim(),
        owner_label: draft.owner_label?.trim() || null,
        route_codes: draft.scope === "routes" ? draft.route_codes : [],
      });
      toast.success("Rule saved");
      setDraft(null);
    } catch (e: any) { toast.error(e?.message ?? "Save failed"); }
  }

  async function runEvaluate(dryRun: boolean, ruleId?: string | null) {
    try {
      const res: any = await evaluate.mutateAsync({ dryRun, ruleId: ruleId ?? null });
      if (!res?.ok) { toast.error(res?.error ?? "Evaluation failed"); return; }
      if (dryRun) {
        setPreview(res);
        toast.success(`Dry run complete — ${res.decisions.filter((d: any) => d.fired).length} route(s) would alert`);
      } else {
        toast.success(`${res.fired} alert(s) fired`);
        if (res.errors?.length) toast.warning(res.errors[0]);
        alerts.refetch();
      }
    } catch (e: any) { toast.error(e?.message ?? "Evaluation failed"); }
  }

  if (!isManager) {
    return <RepAlertList rows={alertRows} loading={alerts.isLoading} onStatus={(id, status) => setStatus.mutate({ id, status })} />;
  }

  const wouldFire = (preview?.decisions ?? []).filter((d: any) => d.fired);

  return (
    <div className="space-y-4 mt-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard title="Open alerts" value={String(openCount)} icon={Bell} />
        <KpiCard title="Active rules" value={String((rules.data?.rules ?? []).filter((r: any) => r.active).length)} icon={AlertTriangle} />
        <KpiCard title="Alerts (all time)" value={String(alertRows.length)} icon={Bell} />
      </div>

      {/* Rules */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div>
            <h3 className="font-semibold text-sm">Alert rules</h3>
            <p className="text-xs text-muted-foreground">
              Fires when a route's capacity stays under the threshold for N consecutive delivery days.
              Cooldown prevents re-alerting the same route too soon.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => runEvaluate(true)} disabled={evaluate.isPending}>
              {evaluate.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
              Evaluate now (dry run)
            </Button>
            <Button size="sm" onClick={() => setDraft({ ...EMPTY_RULE })}><Plus className="w-4 h-4 mr-1" />New rule</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Cooldown</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rules.data?.rules ?? []).map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{Number(r.threshold_pct)}%</TableCell>
                  <TableCell>{r.consecutive_days}</TableCell>
                  <TableCell className="text-xs">{r.scope === "all" ? "All routes" : `${(r.route_codes ?? []).length} route(s)`}</TableCell>
                  <TableCell>{r.cooldown_days}d</TableCell>
                  <TableCell className="text-xs">{(r.channels ?? []).join(", ")}{r.manager_digest ? " + digest" : ""}</TableCell>
                  <TableCell className="text-xs">{r.owner_label ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={r.active ? "default" : "outline"}>{r.active ? "Active" : "Off"}</Badge>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setDraft({
                      id: r.id, name: r.name, threshold_pct: Number(r.threshold_pct), consecutive_days: r.consecutive_days,
                      scope: r.scope, route_codes: r.route_codes ?? [], active: r.active, cooldown_days: r.cooldown_days,
                      channels: r.channels ?? ["in_app"], owner_label: r.owner_label ?? "", manager_digest: !!r.manager_digest,
                      lookback_days: r.lookback_days ?? 14,
                    })}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => runEvaluate(true, r.id)}>Dry run</Button>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      if (!confirm(`Delete rule "${r.name}"?`)) return;
                      try { await delRule.mutateAsync(r.id); toast.success("Rule deleted"); }
                      catch (e: any) { toast.error(e?.message ?? "Delete failed"); }
                    }}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
              {(rules.data?.rules ?? []).length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-sm text-muted-foreground">No rules yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Dry-run preview */}
      {preview && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold text-sm">Dry run preview</h3>
              <p className="text-xs text-muted-foreground">
                {wouldFire.length} route(s) would alert across {preview.evaluatedRules} rule(s). Nothing was sent.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Dismiss</Button>
              <Button size="sm" disabled={wouldFire.length === 0 || evaluate.isPending} onClick={() => runEvaluate(false)}>
                Fire these alerts
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead>Rep(s)</TableHead>
                  <TableHead>Streak</TableHead>
                  <TableHead className="text-right">Streak avg</TableHead>
                  <TableHead className="text-right">Month</TableHead>
                  <TableHead className="text-right">Quarter</TableHead>
                  <TableHead className="text-right">12 mo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wouldFire.map((d: any, i: number) => (
                  <TableRow key={`${d.route_code}-${i}`}>
                    <TableCell className="font-medium">{d.route_code}<div className="text-xs text-muted-foreground">{d.route_name}</div></TableCell>
                    <TableCell className="text-xs">
                      {d.reps.length === 0 ? <span className="italic text-muted-foreground">unassigned</span> : d.reps.map((r: any) => (
                        <span key={r.rep_code} className="mr-2">
                          {r.rep_code}
                          {r.muted && <Badge variant="outline" className="ml-1 text-[10px]">muted</Badge>}
                          {r.capped && <Badge variant="outline" className="ml-1 text-[10px]">cap</Badge>}
                          {!r.email && <Badge variant="outline" className="ml-1 text-[10px]">no email</Badge>}
                        </span>
                      ))}
                    </TableCell>
                    <TableCell className="text-xs">{d.streak_days}d ({d.streak_from} → {d.streak_to})</TableCell>
                    <TableCell className="text-right">{pct(d.avg_in_streak)}</TableCell>
                    <TableCell className="text-right">{pct(d.avg_month)}</TableCell>
                    <TableCell className="text-right">{pct(d.avg_quarter)}</TableCell>
                    <TableCell className="text-right">{pct(d.avg_year)}</TableCell>
                  </TableRow>
                ))}
                {wouldFire.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-sm text-muted-foreground">Nothing would fire right now.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <Collapsible className="mt-3">
            <CollapsibleTrigger className="text-xs text-muted-foreground flex items-center gap-1">
              <ChevronDown className="w-3 h-3" />Show all {preview.decisions.length} evaluation decisions
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 max-h-64 overflow-auto text-xs space-y-1">
                {preview.decisions.map((d: any, i: number) => (
                  <div key={i} className="flex gap-2">
                    <span className="font-mono w-20 shrink-0">{d.route_code}</span>
                    <span className={d.fired ? "text-destructive" : "text-muted-foreground"}>{d.reason}</span>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}

      {/* Fired alerts */}
      <Card className="p-4">
        <h3 className="font-semibold text-sm mb-3">Fired alerts</h3>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fired</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Rep(s)</TableHead>
                <TableHead>Streak</TableHead>
                <TableHead className="text-right">Streak avg</TableHead>
                <TableHead className="text-right">Month</TableHead>
                <TableHead className="text-right">Quarter</TableHead>
                <TableHead className="text-right">12 mo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {alertRows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-xs whitespace-nowrap">{new Date(a.fired_at).toLocaleString()}</TableCell>
                  <TableCell className="font-medium">{a.route_code}</TableCell>
                  <TableCell className="text-xs">
                    {(a.rep_codes ?? []).length ? (a.rep_codes as string[]).join(", ") : <span className="italic text-muted-foreground">unassigned</span>}
                    {(a.delivery?.muted_reps ?? []).length > 0 && (
                      <Badge variant="outline" className="ml-1 text-[10px]"><BellOff className="w-3 h-3 mr-1" />opted out</Badge>
                    )}
                    {(a.delivery?.capped_reps ?? []).length > 0 && (
                      <Badge variant="outline" className="ml-1 text-[10px]">weekly cap</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{a.streak_days}d</TableCell>
                  <TableCell className="text-right">{pct(a.avg_utilization_in_streak)}</TableCell>
                  <TableCell className="text-right">{pct(a.avg_month)}</TableCell>
                  <TableCell className="text-right">{pct(a.avg_quarter)}</TableCell>
                  <TableCell className="text-right">{pct(a.avg_year)}</TableCell>
                  <TableCell>
                    <Badge variant={a.status === "new" ? "destructive" : a.status === "acknowledged" ? "secondary" : "outline"}>{a.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {a.status !== "resolved" && (
                      <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: a.id, status: a.status === "new" ? "acknowledged" : "resolved" })}>
                        {a.status === "new" ? "Acknowledge" : "Resolve"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {alertRows.length === 0 && (
                <TableRow><TableCell colSpan={10} className="text-sm text-muted-foreground">No alerts have fired yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <GovernanceCard />

      {/* Evaluation audit log */}
      <Card className="p-4">
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-semibold">
            <ChevronDown className="w-4 h-4" />Evaluation log ({(log.data?.rows ?? []).length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 max-h-80 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(log.data?.rows ?? []).map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs whitespace-nowrap">{new Date(r.evaluated_at).toLocaleString()}</TableCell>
                      <TableCell className="text-xs font-mono">{r.route_code}</TableCell>
                      <TableCell className="text-xs">
                        {r.fired ? <Badge variant="destructive">fired</Badge> : r.dry_run ? <Badge variant="outline">dry run</Badge> : <Badge variant="secondary">skipped</Badge>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* Rule editor */}
      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{draft?.id ? "Edit rule" : "New alert rule"}</DialogTitle></DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Name</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Underfilled trucks — 75% for 3 days" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Threshold %</Label>
                  <Input type="number" min={1} max={100} value={draft.threshold_pct}
                    onChange={(e) => setDraft({ ...draft, threshold_pct: Number(e.target.value) })} />
                </div>
                <div>
                  <Label className="text-xs">Consecutive days</Label>
                  <Select value={String(draft.consecutive_days)} onValueChange={(v) => setDraft({ ...draft, consecutive_days: Number(v) })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="3">3</SelectItem>
                      <SelectItem value="4">4</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Cooldown (days)</Label>
                  <Input type="number" min={0} max={365} value={draft.cooldown_days}
                    onChange={(e) => setDraft({ ...draft, cooldown_days: Number(e.target.value) })} />
                </div>
                <div>
                  <Label className="text-xs">Lookback window (days)</Label>
                  <Input type="number" min={3} max={90} value={draft.lookback_days}
                    onChange={(e) => setDraft({ ...draft, lookback_days: Number(e.target.value) })} />
                </div>
              </div>
              <div>
                <Label className="text-xs">Scope</Label>
                <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as any })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All active routes</SelectItem>
                    <SelectItem value="routes">Specific routes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.scope === "routes" && (
                <div>
                  <Label className="text-xs">Route codes (one per line or comma separated)</Label>
                  <Textarea rows={3} value={draft.route_codes.join(", ")}
                    onChange={(e) => setDraft({ ...draft, route_codes: e.target.value.split(/[\n,]/).map((s) => s.trim().toUpperCase()).filter(Boolean) })} />
                  <p className="text-[11px] text-muted-foreground mt-1">Known: {routes.map((r) => r.code).join(", ")}</p>
                </div>
              )}
              <div>
                <Label className="text-xs">Channels</Label>
                <div className="flex items-center gap-4 mt-1">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={draft.channels.includes("in_app")} onCheckedChange={(v) => setDraft({
                      ...draft, channels: v ? Array.from(new Set([...draft.channels, "in_app" as const])) : draft.channels.filter((c) => c !== "in_app"),
                    })} />In-app
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={draft.channels.includes("email")} onCheckedChange={(v) => setDraft({
                      ...draft, channels: v ? Array.from(new Set([...draft.channels, "email" as const])) : draft.channels.filter((c) => c !== "email"),
                    })} />Email
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">SMS can be added later without a schema change.</p>
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Manager daily digest</Label>
                <Switch checked={draft.manager_digest} onCheckedChange={(v) => setDraft({ ...draft, manager_digest: v })} />
              </div>
              <div>
                <Label className="text-xs">Accountable owner</Label>
                <Input value={draft.owner_label ?? ""} onChange={(e) => setDraft({ ...draft, owner_label: e.target.value })} placeholder="e.g. Logistics admin" />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">Active</Label>
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button onClick={onSaveRule} disabled={saveRule.isPending}>
              {saveRule.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* --------------------------------------------------------- governance card */

function GovernanceCard() {
  const prefs = useCapacityAlertPrefs();
  const savePref = useSaveCapacityAlertPref();
  const settings = useCapacityAlertSettings();
  const saveSettings = useSaveCapacityAlertSettings();
  const [emails, setEmails] = useState("");

  useEffect(() => {
    if (settings.data) setEmails((settings.data.managerEmails ?? []).join(", "));
  }, [settings.data]);

  const rows = (prefs.data?.rows ?? []) as any[];
  const mutedCount = useMemo(() => rows.filter((r) => !r.opted_in).length, [rows]);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-sm">Governance</h3>
          <p className="text-xs text-muted-foreground">
            Per-salesperson opt-in and weekly alert cap. Muted reps stay visible here so silence is never invisible.
          </p>
        </div>
        {mutedCount > 0 && <Badge variant="outline"><BellOff className="w-3 h-3 mr-1" />{mutedCount} opted out</Badge>}
      </div>

      <div className="mb-4">
        <Label className="text-xs">Manager digest recipients (comma separated)</Label>
        <div className="flex gap-2 mt-1">
          <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="owner@ndi.com, logistics@ndi.com" />
          <Button size="sm" onClick={async () => {
            const list = emails.split(",").map((s) => s.trim()).filter(Boolean);
            try { await saveSettings.mutateAsync(list); toast.success("Recipients saved"); }
            catch (e: any) { toast.error(e?.message ?? "Save failed"); }
          }}>Save</Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">Empty falls back to the rule owner, then all admins.</p>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Rep</TableHead>
              <TableHead>Routes</TableHead>
              <TableHead>Receives alerts</TableHead>
              <TableHead>Max / week</TableHead>
              <TableHead>Email override</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.rep_code} className={r.opted_in ? "" : "opacity-70"}>
                <TableCell className="font-medium">{r.rep_code}<div className="text-xs text-muted-foreground">{r.rep_name ?? ""}</div></TableCell>
                <TableCell>{r.routes}</TableCell>
                <TableCell>
                  <Switch checked={r.opted_in} onCheckedChange={(v) => savePref.mutate({
                    rep_code: r.rep_code, opted_in: v, max_per_week: r.max_per_week, email_override: r.email_override,
                  })} />
                </TableCell>
                <TableCell>
                  <Input className="w-20" type="number" min={0} max={50} defaultValue={r.max_per_week}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== r.max_per_week) savePref.mutate({ rep_code: r.rep_code, opted_in: r.opted_in, max_per_week: v, email_override: r.email_override });
                    }} />
                </TableCell>
                <TableCell>
                  <Input className="w-56" defaultValue={r.email_override ?? ""} placeholder="(profile email)"
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== r.email_override) savePref.mutate({ rep_code: r.rep_code, opted_in: r.opted_in, max_per_week: r.max_per_week, email_override: v });
                    }} />
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-sm text-muted-foreground">No route-to-salesperson assignments yet — set them up in Settings.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------- rep self view */

function RepAlertList({ rows, loading, onStatus }: {
  rows: any[]; loading: boolean;
  onStatus: (id: string, status: "acknowledged" | "resolved") => void;
}) {
  return (
    <Card className="p-4 mt-4">
      <h3 className="font-semibold text-sm mb-1">Your capacity alerts</h3>
      <p className="text-xs text-muted-foreground mb-3">Alerts raised on the routes assigned to you.</p>
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && rows.length === 0 && <p className="text-sm text-muted-foreground">No alerts — your trucks are running above threshold.</p>}
      <div className="space-y-3">
        {rows.map((a) => (
          <div key={a.id} className="border rounded-md p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{a.route_code}</span>
              <Badge variant={a.status === "new" ? "destructive" : a.status === "acknowledged" ? "secondary" : "outline"}>{a.status}</Badge>
              <span className="text-xs text-muted-foreground">{new Date(a.fired_at).toLocaleString()}</span>
            </div>
            <p className="text-sm mt-1">
              {pct(a.avg_utilization_in_streak)} average over {a.streak_days} consecutive days ({a.streak_from} → {a.streak_to}),
              below the {Number(a.threshold_pct)}% target.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              This month {pct(a.avg_month)} · Past quarter {pct(a.avg_quarter)} · Past 12 months {pct(a.avg_year)}
            </p>
            {a.status !== "resolved" && (
              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs"
                onClick={() => onStatus(a.id, a.status === "new" ? "acknowledged" : "resolved")}>
                {a.status === "new" ? "Acknowledge" : "Resolve"}
              </Button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
