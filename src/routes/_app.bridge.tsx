import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, RefreshCw, Play, Wifi, WifiOff, RotateCcw, Eye, AlertCircle, Clock, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { enqueueP21Job, getBridgeStatus, retryBridgeJob } from "@/server/p21.functions";
import { formatDistanceToNow } from "date-fns";
import { ModuleHeader } from "@/components/shared/ModuleHeader";
import { KpiCard } from "@/components/shared/KpiCard";

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
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recent, setRecent] = useState<Job[]>([]);
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
      const res = await getBridgeStatus();
      setAgents(res.agents as Agent[]);
      setRecent(res.recent as Job[]);
      setPendingCount(res.pendingCount);
      setFailedCount(res.failedCount);
    } catch (e: any) {
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
      const res = await enqueueP21Job({ data: { kind: "ping", payload: {}, timeoutMs: 15000 } });
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
      await retryBridgeJob({ data: { jobId } });
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
