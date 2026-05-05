import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { Play, Plus, Download, Loader2, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useAuth, type AppRole } from "@/lib/auth";
import { formatDistanceToNow } from "date-fns";
import { REPORT_TYPES, DATE_RANGES, generateAndExport, type ReportType, type DateRangePreset, type ReportFormat } from "@/lib/reports";

export const Route = createFileRoute("/_app/reports")({ component: ReportsPage });

const ROLES: AppRole[] = ["admin", "ops_orders", "ops_ar", "ops_logistics", "ops_reports", "sales_rep"];

type Schedule = {
  id: string;
  name: string;
  type: ReportType;
  schedule_cron: string;
  recipients: string[];
  date_range: DateRangePreset;
  audience_roles: AppRole[];
  format: ReportFormat;
  filters: Record<string, any>;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
};

function emptySchedule(): Schedule {
  return {
    id: "", name: "", type: "orders", schedule_cron: "0 8 * * 1",
    recipients: [], date_range: "last_7_days", audience_roles: [], format: "csv",
    filters: {}, active: true, last_run_at: null, last_status: null,
  };
}

function ReportsPage() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  async function load() {
    const [{ data: s }, { data: r }] = await Promise.all([
      supabase.from("report_schedules").select("*").order("name"),
      supabase.from("report_runs").select("*").order("started_at", { ascending: false }).limit(30),
    ]);
    setSchedules((s ?? []) as Schedule[]);
    setRuns(r ?? []);
  }
  useEffect(() => { load(); }, []);

  async function runNow(s: Schedule) {
    setRunning(s.id);
    const startedAt = new Date().toISOString();
    const { data: run } = await supabase.from("report_runs").insert({ schedule_id: s.id, started_at: startedAt, status: "running" }).select().single();
    try {
      const result = await generateAndExport({ name: s.name, type: s.type, preset: s.date_range, format: s.format, filters: s.filters });
      await supabase.from("report_runs").update({
        completed_at: new Date().toISOString(), status: "success",
        recipients_count: s.recipients.length,
        notes: `${result.rowCount} rows · ${result.range} · ${s.format.toUpperCase()}`,
      }).eq("id", run!.id);
      await supabase.from("report_schedules").update({ last_run_at: new Date().toISOString(), last_status: "success" }).eq("id", s.id);
      await supabase.from("activity_events").insert({
        event_type: "report.generated", entity_type: "report_schedule", entity_id: s.id,
        actor_id: user?.id, actor_name: user?.email ?? "system",
        message: `${s.name} (${s.format.toUpperCase()}, ${result.rowCount} rows) generated`,
        metadata: { range: result.range, format: s.format, recipients: s.recipients.length },
      });
      toast.success(`${s.name} downloaded (${result.rowCount} rows)`);
    } catch (e: any) {
      await supabase.from("report_runs").update({ completed_at: new Date().toISOString(), status: "failed", notes: e.message?.slice(0, 200) }).eq("id", run!.id);
      await supabase.from("report_schedules").update({ last_status: "failed" }).eq("id", s.id);
      toast.error(e.message ?? "Report failed");
    } finally {
      setRunning(null); load();
    }
  }

  async function save(s: Schedule) {
    const payload = {
      name: s.name, type: s.type, schedule_cron: s.schedule_cron,
      recipients: s.recipients, date_range: s.date_range,
      audience_roles: s.audience_roles, format: s.format, filters: s.filters, active: s.active,
    };
    const { error } = s.id
      ? await supabase.from("report_schedules").update(payload).eq("id", s.id)
      : await supabase.from("report_schedules").insert(payload);
    if (error) return toast.error(error.message);
    toast.success("Saved");
    setEditing(null); load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this schedule?")) return;
    await supabase.from("report_schedules").delete().eq("id", id);
    toast.success("Deleted"); load();
  }

  return (
    <div>
      <ModuleHeader
        title="Reports"
        description="Configure filters, audience, and delivery format. Run on demand or on schedule."
        actions={<Button onClick={() => setEditing(emptySchedule())}><Plus className="w-4 h-4 mr-2" /> New Report</Button>}
      />

      <Card className="mb-6">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Range</TableHead>
            <TableHead>Format</TableHead><TableHead>Audience</TableHead><TableHead>Schedule</TableHead>
            <TableHead>Last Run</TableHead><TableHead>Status</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>{schedules.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.name}{!s.active && <Badge variant="outline" className="ml-2 text-xs">paused</Badge>}</TableCell>
              <TableCell><Badge variant="secondary">{REPORT_TYPES.find((t) => t.value === s.type)?.label ?? s.type}</Badge></TableCell>
              <TableCell className="text-xs">{DATE_RANGES.find((d) => d.value === s.date_range)?.label ?? s.date_range}</TableCell>
              <TableCell><Badge variant="outline" className="uppercase">{s.format}</Badge></TableCell>
              <TableCell className="text-xs">{(s.audience_roles ?? []).join(", ") || "—"}</TableCell>
              <TableCell><code className="text-xs">{s.schedule_cron}</code></TableCell>
              <TableCell className="text-xs">{s.last_run_at ? formatDistanceToNow(new Date(s.last_run_at), { addSuffix: true }) : "Never"}</TableCell>
              <TableCell>{s.last_status ? <Badge variant={s.last_status === "success" ? "default" : "destructive"}>{s.last_status}</Badge> : "—"}</TableCell>
              <TableCell className="flex gap-1 justify-end">
                <Button size="sm" variant="outline" onClick={() => runNow(s)} disabled={running === s.id}>
                  {running === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ ...s, recipients: s.recipients ?? [], audience_roles: s.audience_roles ?? [], filters: s.filters ?? {} })}><Pencil className="w-3 h-3" /></Button>
                <Button size="sm" variant="ghost" onClick={() => remove(s.id)}><Trash2 className="w-3 h-3" /></Button>
              </TableCell>
            </TableRow>))}
            {!schedules.length && <TableRow><TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">No reports yet — click <strong>New Report</strong>.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>

      <Card>
        <div className="p-4 font-semibold border-b flex items-center gap-2"><Download className="w-4 h-4" /> Recent runs</div>
        <Table>
          <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Status</TableHead><TableHead>Recipients</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
          <TableBody>{runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="text-xs">{formatDistanceToNow(new Date(r.started_at), { addSuffix: true })}</TableCell>
              <TableCell><Badge variant={r.status === "success" ? "default" : r.status === "running" ? "secondary" : "destructive"}>{r.status}</Badge></TableCell>
              <TableCell>{r.recipients_count}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{r.notes ?? "—"}</TableCell>
            </TableRow>))}
          </TableBody>
        </Table>
      </Card>

      {editing && <ScheduleEditor schedule={editing} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function ScheduleEditor({ schedule, onClose, onSave }: { schedule: Schedule; onClose: () => void; onSave: (s: Schedule) => void }) {
  const [s, setS] = useState<Schedule>(schedule);
  const [recipientText, setRecipientText] = useState((schedule.recipients ?? []).join(", "));

  function commit() {
    const recipients = recipientText.split(",").map((r) => r.trim()).filter(Boolean);
    if (!s.name.trim()) return toast.error("Name is required");
    onSave({ ...s, recipients });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{s.id ? "Edit report" : "New report"}</DialogTitle></DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2"><Label>Name</Label>
            <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Weekly Orders Summary" />
          </div>
          <div><Label>Report type</Label>
            <Select value={s.type} onValueChange={(v) => setS({ ...s, type: v as ReportType })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{REPORT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Date range</Label>
            <Select value={s.date_range} onValueChange={(v) => setS({ ...s, date_range: v as DateRangePreset })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{DATE_RANGES.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Format</Label>
            <Select value={s.format} onValueChange={(v) => setS({ ...s, format: v as ReportFormat })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="csv">CSV</SelectItem><SelectItem value="pdf">PDF</SelectItem></SelectContent>
            </Select>
          </div>
          <div><Label>Cron schedule</Label>
            <Input value={s.schedule_cron} onChange={(e) => setS({ ...s, schedule_cron: e.target.value })} placeholder="0 8 * * 1" />
            <p className="text-xs text-muted-foreground mt-1">e.g. <code>0 8 * * 1</code> = Mondays 08:00</p>
          </div>
          <div className="md:col-span-2"><Label>Recipients (comma-separated emails)</Label>
            <Input value={recipientText} onChange={(e) => setRecipientText(e.target.value)} placeholder="alice@ndi.com, bob@ndi.com" />
          </div>
          <div className="md:col-span-2">
            <Label>Audience roles (only users with these roles see/receive this report)</Label>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {ROLES.map((r) => {
                const checked = (s.audience_roles ?? []).includes(r);
                return (
                  <label key={r} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={checked} onCheckedChange={(v) => {
                      const next = v ? [...(s.audience_roles ?? []), r] : (s.audience_roles ?? []).filter((x) => x !== r);
                      setS({ ...s, audience_roles: next });
                    }} />
                    {r}
                  </label>
                );
              })}
            </div>
          </div>
          {s.type === "ar_aging" && (
            <div><Label>Bucket filter</Label>
              <Select value={s.filters.bucket ?? "all"} onValueChange={(v) => setS({ ...s, filters: { ...s.filters, bucket: v === "all" ? undefined : v } })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All buckets</SelectItem>
                  <SelectItem value="0-30">0–30 days</SelectItem>
                  <SelectItem value="31-60">31–60 days</SelectItem>
                  <SelectItem value="61-90">61–90 days</SelectItem>
                  <SelectItem value="90+">90+ days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {s.type === "orders" && (
            <div><Label>Status filter</Label>
              <Select value={s.filters.status ?? "all"} onValueChange={(v) => setS({ ...s, filters: { ...s.filters, status: v === "all" ? undefined : v } })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending_review">Pending review</SelectItem>
                  <SelectItem value="submitted_to_p21">Submitted</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="md:col-span-2 flex items-center justify-between border-t pt-4">
            <div className="flex items-center gap-2">
              <Switch checked={s.active} onCheckedChange={(v) => setS({ ...s, active: v })} id="active" />
              <Label htmlFor="active">Active (will run on schedule)</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={commit}>Save report</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
