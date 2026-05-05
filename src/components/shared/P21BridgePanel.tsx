import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, RefreshCw, Play, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { enqueueP21Job, getBridgeStatus } from "@/server/p21.functions";
import { formatDistanceToNow } from "date-fns";

type Agent = { id: string; name: string; version: string | null; ip: string | null; last_seen_at: string | null };
type Job = { id: string; kind: string; status: string; created_at: string; completed_at: string | null; error: string | null };

function agentHealth(lastSeenAt: string | null) {
  if (!lastSeenAt) return { label: "never", color: "bg-muted text-muted-foreground", icon: WifiOff };
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < 60_000) return { label: "online", color: "bg-success text-success-foreground", icon: Wifi };
  if (ageMs < 5 * 60_000) return { label: "stale", color: "bg-warning text-warning-foreground", icon: Wifi };
  return { label: "offline", color: "bg-destructive text-destructive-foreground", icon: WifiOff };
}

export function P21BridgePanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recent, setRecent] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [pinging, setPinging] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await getBridgeStatus();
      setAgents(res.agents as Agent[]);
      setRecent(res.recent as Job[]);
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

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">P21 Bridge</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Runs P21 SQL through a small Node agent on a machine inside your network with FortiClient connected. The
              agent dials out — no inbound firewall rule is required. Setup instructions live in the{" "}
              <code>agent/</code> folder of this repo.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </Button>
            <Button size="sm" onClick={runPing} disabled={pinging || agents.length === 0}>
              {pinging ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
              Run ping
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h4 className="font-semibold mb-3">Agents</h4>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents have checked in yet. Install the agent following <code>agent/README.md</code>, then it will appear
            here within a few seconds.
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
        <h4 className="font-semibold mb-3">Recent jobs</h4>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((j) => (
                <TableRow key={j.id}>
                  <TableCell><code>{j.kind}</code></TableCell>
                  <TableCell>
                    <Badge
                      className={
                        j.status === "done"
                          ? "bg-success text-success-foreground"
                          : j.status === "error"
                          ? "bg-destructive text-destructive-foreground"
                          : j.status === "claimed"
                          ? "bg-primary text-primary-foreground"
                          : ""
                      }
                    >
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(j.created_at), { addSuffix: true })}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {j.completed_at ? formatDistanceToNow(new Date(j.completed_at), { addSuffix: true }) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-destructive max-w-xs truncate">{j.error ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
