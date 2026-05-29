import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Plus, Play, Pencil, Trash2, Database, Mail, RefreshCw } from "lucide-react";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import {
  listSqlSchedules,
  upsertSqlSchedule,
  deleteSqlSchedule,
  runSqlScheduleNow,
  previewSqlSchedule,
} from "@/lib/sql-schedules.functions";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app/sql-schedules")({ component: SqlSchedulesPage });

type Schedule = {
  id: string;
  name: string;
  description: string | null;
  sql: string;
  params: any;
  action: "email" | "upsert_price_list";
  recipients: string[];
  email_subject: string | null;
  schedule_cron: string;
  timezone: string;
  active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_row_count: number | null;
  last_error: string | null;
};

import { describeCron, defaultHuman, fromCron, toCron, WEEKDAYS, type HumanSchedule } from "@/lib/cron-human";

function blankSchedule(): Schedule {
  return {
    id: "",
    name: "",
    description: "",
    sql: "SELECT TOP 100 * FROM oe_hdr ORDER BY order_date_time DESC",
    params: {},
    action: "email",
    recipients: [],
    email_subject: "{{name}} — {{date}} ({{rows}} rows)",
    schedule_cron: "0 8 * * 1",
    timezone: "America/New_York",
    active: true,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_row_count: null,
    last_error: null,
  };
}

function SqlSchedulesPage() {
  const { hasRole } = useAuth();
  const list = useServerFn(listSqlSchedules);
  const upsert = useServerFn(upsertSqlSchedule);
  const remove = useServerFn(deleteSqlSchedule);
  const runNow = useServerFn(runSqlScheduleNow);

  const [rows, setRows] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await list();
      setRows(((res as any).rows ?? []) as Schedule[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).get("prefill")) return;
    try {
      const raw = localStorage.getItem("sql.schedule.prefill");
      if (!raw) return;
      const { sql, params } = JSON.parse(raw);
      const s = blankSchedule();
      s.sql = sql ?? s.sql;
      try { s.params = params ? JSON.parse(params) : {}; } catch { s.params = {}; }
      setEditing(s);
      localStorage.removeItem("sql.schedule.prefill");
    } catch {}
  }, []);

  async function handleRunNow(s: Schedule) {
    setRunningId(s.id);
    try {
      const r = (await runNow({ data: { id: s.id } })) as any;
      if (r.status === "success") toast.success(`Ran — ${r.rowCount} rows`);
      else toast.error(`Failed: ${r.error}`);
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Run failed");
    } finally {
      setRunningId(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this schedule?")) return;
    try {
      await remove({ data: { id } });
      toast.success("Deleted");
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "Delete failed");
    }
  }

  if (!hasRole("admin")) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Scheduled queries are admin-only.
      </div>
    );
  }


  return (
    <div className="space-y-6">
      <ModuleHeader
        title="Scheduled SQL Queries"
        description="Run SELECT queries against P21 on a cron — email the results, or refresh the pricing catalog."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Refresh
            </Button>
            <Button size="sm" onClick={() => setEditing(blankSchedule())}>
              <Plus className="w-4 h-4 mr-2" /> New schedule
            </Button>
            <Link to="/bridge"><Button variant="ghost" size="sm">SQL console</Button></Link>
          </div>
        }
      />

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Cron</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Recipients</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">
                  {s.name}
                  {!s.active && <Badge variant="outline" className="ml-2 text-xs">paused</Badge>}
                  {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {s.action === "email" ? <><Mail className="w-3 h-3 mr-1 inline" /> email</> : <><Database className="w-3 h-3 mr-1 inline" /> price_list</>}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {describeCron(s.schedule_cron)}
                  <div className="text-[10px] text-muted-foreground font-mono">{s.schedule_cron} · {s.timezone}</div>
                </TableCell>
                <TableCell className="text-xs">{s.next_run_at ? formatDistanceToNow(new Date(s.next_run_at), { addSuffix: true }) : "—"}</TableCell>
                <TableCell className="text-xs">
                  {s.last_run_at ? formatDistanceToNow(new Date(s.last_run_at), { addSuffix: true }) : "Never"}
                  {s.last_status && (
                    <Badge variant={s.last_status === "success" ? "default" : "destructive"} className="ml-1 text-[10px]">
                      {s.last_status}
                    </Badge>
                  )}
                  {s.last_error && <div className="text-[10px] text-destructive truncate max-w-[240px]" title={s.last_error}>{s.last_error}</div>}
                </TableCell>
                <TableCell className="text-xs">{s.last_row_count ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {s.action === "email" ? (s.recipients?.length ? s.recipients.join(", ") : "—") : "—"}
                </TableCell>
                <TableCell className="flex gap-1 justify-end">
                  <Button size="sm" variant="outline" onClick={() => handleRunNow(s)} disabled={runningId === s.id}>
                    {runningId === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ ...s, recipients: s.recipients ?? [], params: s.params ?? {} })}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleDelete(s.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">
                No schedules yet — click <strong>New schedule</strong>.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {editing && (
        <ScheduleEditor
          schedule={editing}
          onClose={() => setEditing(null)}
          onSave={async (s) => {
            try {
              await upsert({
                data: {
                  id: s.id || undefined,
                  name: s.name,
                  description: s.description || null,
                  sql: s.sql,
                  params: s.params,
                  action: s.action,
                  recipients: s.recipients,
                  email_subject: s.email_subject || null,
                  schedule_cron: s.schedule_cron,
                  timezone: s.timezone,
                  active: s.active,
                } as any,
              });
              toast.success("Saved");
              setEditing(null);
              refresh();
            } catch (e: any) {
              toast.error(e?.message ?? "Save failed");
            }
          }}
        />
      )}
    </div>
  );
}

function ScheduleEditor({
  schedule, onClose, onSave,
}: {
  schedule: Schedule;
  onClose: () => void;
  onSave: (s: Schedule) => void;
}) {
  const [s, setS] = useState<Schedule>(schedule);
  const [paramsJson, setParamsJson] = useState(JSON.stringify(s.params ?? {}, null, 2));
  const [recipientText, setRecipientText] = useState((s.recipients ?? []).join(", "));
  const [previewing, setPreviewing] = useState(false);
  const [previewRows, setPreviewRows] = useState<any[] | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const preview = useServerFn(previewSqlSchedule);

  const columns = useMemo(() => (previewRows?.length ? Object.keys(previewRows[0]) : []), [previewRows]);

  function parseParams(): Record<string, any> {
    const t = paramsJson.trim();
    if (!t || t === "{}") return {};
    return JSON.parse(t);
  }

  async function runPreview() {
    setPreviewing(true); setPreviewErr(null); setPreviewRows(null);
    try {
      const params = parseParams();
      const res = (await preview({ data: { sql: s.sql, params, maxRows: 20 } })) as any;
      setPreviewRows(res.rows ?? []);
      toast.success(`Preview ok — ${res.total} rows (showing ${(res.rows ?? []).length})`);
    } catch (e: any) {
      setPreviewErr(e?.message ?? "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  function commit() {
    if (!s.name.trim()) return toast.error("Name is required");
    if (!s.schedule_cron.trim()) return toast.error("Cron is required");
    let params: Record<string, any> = {};
    try { params = parseParams(); } catch (e: any) { return toast.error(`Params JSON: ${e.message}`); }
    const recipients = recipientText.split(",").map((r) => r.trim()).filter(Boolean);
    if (s.action === "email" && recipients.length === 0) return toast.error("Add at least one recipient");
    onSave({ ...s, params, recipients });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{s.id ? "Edit schedule" : "New schedule"}</DialogTitle></DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label>Name</Label>
            <Input value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Weekly aged AR > 90" />
          </div>
          <div className="md:col-span-2">
            <Label>Description</Label>
            <Input value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} placeholder="Optional context" />
          </div>

          <div>
            <Label>Action</Label>
            <Select value={s.action} onValueChange={(v) => setS({ ...s, action: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email results (CSV attachment)</SelectItem>
                <SelectItem value="upsert_price_list">Refresh pricing catalog (price_list)</SelectItem>
              </SelectContent>
            </Select>
            {s.action === "upsert_price_list" && (
              <p className="text-xs text-muted-foreground mt-1">
                Uses the canonical 9-supplier pricer query. The SQL field below is ignored for this action.
              </p>
            )}
          </div>

          <div className="md:col-span-2">
            <Label>Schedule</Label>
            <ScheduleBuilder
              cron={s.schedule_cron}
              onChange={(cron) => setS({ ...s, schedule_cron: cron })}
            />
          </div>


          <div>
            <Label>Timezone</Label>
            <Input value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} placeholder="America/New_York" />
          </div>

          <div className="flex items-center gap-2 self-end pb-2">
            <Switch checked={s.active} onCheckedChange={(v) => setS({ ...s, active: v })} id="active" />
            <Label htmlFor="active">Active</Label>
          </div>

          {s.action === "email" && (
            <>
              <div className="md:col-span-2">
                <Label>Recipients (comma-separated emails)</Label>
                <Input value={recipientText} onChange={(e) => setRecipientText(e.target.value)} placeholder="alice@ndi.com, bob@ndi.com" />
              </div>
              <div className="md:col-span-2">
                <Label>Email subject (template — {`{{name}}, {{date}}, {{rows}}`})</Label>
                <Input value={s.email_subject ?? ""} onChange={(e) => setS({ ...s, email_subject: e.target.value })} placeholder="{{name}} — {{date}}" />
              </div>
            </>
          )}

          <div className="md:col-span-2">
            <Label>SQL query (SELECT/WITH only, single statement)</Label>
            <Textarea
              value={s.sql}
              onChange={(e) => setS({ ...s, sql: e.target.value })}
              className="font-mono text-xs min-h-[180px]"
              disabled={s.action === "upsert_price_list"}
            />
          </div>
          <div className="md:col-span-2">
            <Label>Params (JSON, bind with @name)</Label>
            <Textarea
              value={paramsJson}
              onChange={(e) => setParamsJson(e.target.value)}
              className="font-mono text-xs min-h-[80px]"
              disabled={s.action === "upsert_price_list"}
            />
          </div>

          {s.action === "email" && (
            <div className="md:col-span-2">
              <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
                {previewing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
                Test query (first 20 rows)
              </Button>
              {previewErr && <pre className="mt-2 bg-destructive/10 text-destructive p-2 rounded text-xs whitespace-pre-wrap">{previewErr}</pre>}
              {previewRows && (
                <div className="mt-2 border rounded max-h-[240px] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>{columns.map((c) => <TableHead key={c} className="text-xs">{c}</TableHead>)}</TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewRows.map((row, i) => (
                        <TableRow key={i}>
                          {columns.map((c) => (
                            <TableCell key={c} className="text-xs font-mono max-w-[220px] truncate" title={String(row[c] ?? "")}>
                              {row[c] === null || row[c] === undefined ? <span className="text-muted-foreground">null</span> : String(row[c])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={commit}>Save schedule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
