import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, RefreshCw, Play, Wifi, WifiOff, RotateCcw, Eye, AlertCircle, Clock, CheckCircle2, Database, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { enqueueP21Job, getBridgeStatus, retryBridgeJob, runP21Sql } from "@/lib/p21.functions";
import { formatDistanceToNow } from "date-fns";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";
import { useServerFn } from "@tanstack/react-start";


export const Route = createFileRoute("/_app/bridge")({
  component: BridgeAdminPage,
});

type Agent = { id: string; name: string; version: string | null; ip: string | null; last_seen_at: string | null };
type Job = {
  id: string; kind: string; status: string;
  created_at: string; claimed_at: string | null; completed_at: string | null;
  error: string | null; payload: any; result: any;
};

function agentHealth(lastSeenAt: string | null) {
  if (!lastSeenAt) return { label: "never", color: "bg-muted text-muted-foreground", icon: WifiOff };
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < 60_000) return { label: "online", color: "bg-success text-success-foreground", icon: Wifi };
  if (ageMs < 5 * 60_000) return { label: "stale", color: "bg-warning text-warning-foreground", icon: Wifi };
  return { label: "offline", color: "bg-destructive text-destructive-foreground", icon: WifiOff };
}

function statusBadge(status: string) {
  switch (status) {
    case "done": return "bg-success text-success-foreground";
    case "error": return "bg-destructive text-destructive-foreground";
    case "claimed": return "bg-primary text-primary-foreground";
    case "pending": return "bg-warning text-warning-foreground";
    default: return "";
  }
}

function BridgeAdminPage() {
  const getBridgeStatusFn = useServerFn(getBridgeStatus);
  const enqueueP21JobFn = useServerFn(enqueueP21Job);
  const retryBridgeJobFn = useServerFn(retryBridgeJob);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recent, setRecent] = useState<Job[]>([]);


  // SQL console state
  const runP21SqlFn = useServerFn(runP21Sql);
  const [sql, setSql] = useState<string>("SELECT TOP 50 * FROM inv_mast WHERE item_id = @item");
  const [paramsJson, setParamsJson] = useState<string>('{\n  "item": ""\n}');
  const [maxRows, setMaxRows] = useState<number>(200);
  const [running, setRunning] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlResult, setSqlResult] = useState<{ rows: any[]; count: number; truncated: boolean; ms: number } | null>(null);
  const [recentSql, setRecentSql] = useState<string[]>([]);
  const sqlTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("p21.sql.recent");
      if (raw) setRecentSql(JSON.parse(raw));
    } catch {}
  }, []);

  function pushRecent(q: string) {
    const next = [q, ...recentSql.filter((s) => s !== q)].slice(0, 10);
    setRecentSql(next);
    try { localStorage.setItem("p21.sql.recent", JSON.stringify(next)); } catch {}
  }

  const columns = useMemo(() => {
    if (!sqlResult?.rows?.length) return [] as string[];
    return Object.keys(sqlResult.rows[0]);
  }, [sqlResult]);

  function buildCsv(): string {
    if (!sqlResult?.rows?.length) return "";
    const esc = (v: any) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = columns.join(",");
    const lines = sqlResult.rows.map((r) => columns.map((c) => esc(r[c])).join(","));
    return [header, ...lines].join("\n");
  }

  async function runSql() {
    setSqlError(null);
    let params: Record<string, any> | undefined;
    const trimmedParams = paramsJson.trim();
    if (trimmedParams && trimmedParams !== "{}") {
      try {
        params = JSON.parse(trimmedParams);
      } catch (e: any) {
        setSqlError(`Invalid params JSON: ${e.message}`);
        return;
      }
    }
    setRunning(true);
    const t0 = performance.now();
    try {
      const res = await runP21SqlFn({ data: { sql, params, maxRows } });
      setSqlResult({ ...(res as any), ms: Math.round(performance.now() - t0) });
      pushRecent(sql);
      refresh();
    } catch (e: any) {
      setSqlError(e.message ?? "Query failed");
      setSqlResult(null);
    } finally {
      setRunning(false);
    }
  }

  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "claimed" | "done" | "error">("all");
  const [selected, setSelected] = useState<Job | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await getBridgeStatusFn();
      setAgents(Array.isArray((res as any)?.agents) ? ((res as any).agents as Agent[]) : []);
      setRecent(Array.isArray((res as any)?.recent) ? ((res as any).recent as Job[]) : []);
      setPendingCount(typeof (res as any)?.pendingCount === "number" ? (res as any).pendingCount : 0);
      setFailedCount(typeof (res as any)?.failedCount === "number" ? (res as any).failedCount : 0);
    } catch (e: any) {
      setAgents([]);
      setRecent([]);
      setPendingCount(0);
      setFailedCount(0);
      toast.error(e.message ?? "Failed to load bridge status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function runPing() {
    setPinging(true);
    try {
      const res = await enqueueP21JobFn({ data: { kind: "ping", payload: {}, timeoutMs: 15000 } });
      toast.success(`Ping ok — server time ${(res as any).result?.server_time ?? "?"}`);
      refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Ping failed");
    } finally {
      setPinging(false);
    }
  }

  async function retryJob(jobId: string) {
    setRetrying(jobId);
    try {
      await retryBridgeJobFn({ data: { jobId } });
      toast.success("Job requeued");
      refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Retry failed");
    } finally {
      setRetrying(null);
    }
  }

  const onlineAgents = agents.filter((a) => {
    if (!a.last_seen_at) return false;
    return Date.now() - new Date(a.last_seen_at).getTime() < 60_000;
  }).length;

  const filtered = filter === "all" ? recent : recent.filter((j) => j.status === filter);

  return (
    <div className="space-y-6">
      <ModuleHeader
        title="P21 Bridge"
        description="Monitor agents, queued jobs, and recent results from the local P21 bridge."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
              Refresh
            </Button>
            <Button size="sm" onClick={runPing} disabled={pinging || agents.length === 0}>
              {pinging ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              Run ping
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Agents online" value={`${onlineAgents}/${agents.length}`} icon={<Wifi className="w-5 h-5" />} />
        <KpiCard label="Pending jobs" value={String(pendingCount)} icon={<Clock className="w-5 h-5" />} />
        <KpiCard label="Failed jobs" value={String(failedCount)} icon={<AlertCircle className="w-5 h-5" />} />
        <KpiCard label="Done (recent)" value={String(recent.filter(j => j.status === "done").length)} icon={<CheckCircle2 className="w-5 h-5" />} />
      </div>

      <Card className="p-4">
        <h3 className="font-semibold mb-3">Agent heartbeats</h3>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents have checked in yet. Install the agent following <code>agent/README.md</code>.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => {
                const h = agentHealth(a.last_seen_at);
                const Icon = h.icon;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell>
                      <Badge className={h.color}>
                        <Icon className="w-3 h-3 mr-1" />
                        {h.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.last_seen_at ? formatDistanceToNow(new Date(a.last_seen_at), { addSuffix: true }) : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{a.version ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{a.ip ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h3 className="font-semibold flex items-center gap-2">
            <Database className="w-4 h-4" /> SQL console
          </h3>
          {recentSql.length > 0 && (
            <Select onValueChange={(v) => setSql(v)}>
              <SelectTrigger className="w-[220px] h-8 text-xs">
                <SelectValue placeholder="Recent queries" />
              </SelectTrigger>
              <SelectContent>
                {recentSql.map((q, i) => (
                  <SelectItem key={i} value={q} className="font-mono text-xs">
                    {q.length > 60 ? q.slice(0, 60) + "…" : q}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Read-only (SELECT/WITH). Bind values with <code>@name</code> and supply them in the params JSON. Single statement only.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2">
            <Label className="text-xs">Query</Label>
            <Textarea
              ref={sqlTextareaRef}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (!running) runSql();
                }
              }}
              placeholder="SELECT TOP 50 * FROM inv_mast WHERE item_id = @item"
              className="font-mono text-xs min-h-[180px]"
            />
          </div>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Params (JSON)</Label>
              <Textarea
                value={paramsJson}
                onChange={(e) => setParamsJson(e.target.value)}
                className="font-mono text-xs min-h-[120px]"
              />
            </div>
            <div>
              <Label className="text-xs">Max rows</Label>
              <Input
                type="number"
                min={1}
                max={50000}
                value={maxRows}
                onChange={(e) => setMaxRows(Math.max(1, Math.min(50000, Number(e.target.value) || 1)))}
              />
            </div>
            <Button onClick={runSql} disabled={running} className="w-full">
              {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              Run query <span className="ml-2 text-[10px] opacity-70">⌘/Ctrl+↵</span>
            </Button>
          </div>
        </div>

        {sqlError && (
          <pre className="mt-3 bg-destructive/10 text-destructive p-3 rounded text-xs whitespace-pre-wrap">{sqlError}</pre>
        )}

        {sqlResult && !sqlError && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-xs text-muted-foreground">
                {sqlResult.count} row{sqlResult.count === 1 ? "" : "s"}
                {sqlResult.truncated ? " (truncated)" : ""} · {sqlResult.ms}ms
                {sqlResult.rows.length !== sqlResult.count ? ` · showing ${sqlResult.rows.length}` : ""}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(buildCsv());
                      toast.success("CSV copied to clipboard");
                    } catch {
                      toast.error("Clipboard unavailable");
                    }
                  }}
                  disabled={!sqlResult.rows.length}
                >
                  <Copy className="w-4 h-4 mr-1" /> Copy CSV
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([buildCsv()], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `p21-query-${Date.now()}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  disabled={!sqlResult.rows.length}
                >
                  <Download className="w-4 h-4 mr-1" /> Download .csv
                </Button>
              </div>
            </div>
            {sqlResult.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rows returned.</p>
            ) : (
              <div className="border rounded max-h-[400px] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      {columns.map((c) => (
                        <TableHead key={c} className="text-xs whitespace-nowrap">{c}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sqlResult.rows.map((row, i) => (
                      <TableRow key={i}>
                        {columns.map((c) => (
                          <TableCell key={c} className="text-xs font-mono whitespace-nowrap max-w-[300px] truncate" title={String(row[c] ?? "")}>
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
      </Card>


      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h3 className="font-semibold">Recent jobs</h3>
          <div className="flex gap-1 flex-wrap">
            {(["all", "pending", "claimed", "done", "error"] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                onClick={() => setFilter(f)}
                className="capitalize"
              >
                {f}
              </Button>
            ))}
          </div>
        </div>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs in this view.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Claimed</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((j) => (
                <TableRow key={j.id}>
                  <TableCell><code className="text-xs">{j.kind}</code></TableCell>
                  <TableCell><Badge className={statusBadge(j.status)}>{j.status}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(j.created_at), { addSuffix: true })}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {j.claimed_at ? formatDistanceToNow(new Date(j.claimed_at), { addSuffix: true }) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {j.completed_at ? formatDistanceToNow(new Date(j.completed_at), { addSuffix: true }) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-destructive max-w-[200px] truncate" title={j.error ?? ""}>
                    {j.error ?? ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-1 justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(j)}>
                        <Eye className="w-4 h-4" />
                      </Button>
                      {j.status === "error" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => retryJob(j.id)}
                          disabled={retrying === j.id}
                        >
                          {retrying === j.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              Job <code className="text-sm">{selected?.kind}</code>{" "}
              <Badge className={statusBadge(selected?.status ?? "")}>{selected?.status}</Badge>
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground mb-1">ID</div>
                <code className="text-xs">{selected.id}</code>
              </div>
              {selected.error && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Error</div>
                  <pre className="bg-destructive/10 text-destructive p-2 rounded text-xs whitespace-pre-wrap">{selected.error}</pre>
                </div>
              )}
              <div>
                <div className="text-xs text-muted-foreground mb-1">Payload</div>
                <pre className="bg-muted p-2 rounded text-xs overflow-auto max-h-48">{JSON.stringify(selected.payload, null, 2)}</pre>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Result</div>
                <pre className="bg-muted p-2 rounded text-xs overflow-auto max-h-72">{JSON.stringify(selected.result, null, 2)}</pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
