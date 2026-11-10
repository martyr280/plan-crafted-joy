import { useMemo } from "react";
import { AlertTriangle, Clock, Hammer, Loader2, Send, Truck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KpiCard } from "@/components/shared/KpiCard";
import { DispatchListAlert } from "./RunDetailAlert";
import { dispatchListPanels } from "./run-detail-panels";

export type DispatchBoardRun = {
  id: string;
  runDate: string;
  status: string;
  stopsHeld: number;
  exception?: { kind?: string; badge?: string; message?: string } | null;
};

export type DispatchBoardRoute = {
  routeId: string;
  code: string;
  name: string;
  hub: string;
  enabled: boolean;
  autoPush?: boolean;
  cutoff?: { timeLabel: string; runDates: string[] } | null;
  runs: DispatchBoardRun[];
};

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    planned: "bg-muted text-muted-foreground",
    pushed: "bg-primary/15 text-primary",
    locked: "bg-amber-500/15 text-amber-600",
    cancelled: "bg-destructive/15 text-destructive",
    error: "bg-destructive/15 text-destructive",
  };
  return (
    <Badge className={map[status] ?? "bg-muted text-muted-foreground"} variant="secondary">
      {status}
    </Badge>
  );
}

function ExceptionBadge({
  flag,
}: {
  flag?: { kind?: string; badge?: string; message?: string } | null;
}) {
  if (!flag) return null;
  return flag.kind === "no_run" ? (
    <Badge
      variant="secondary"
      className="ml-1 bg-destructive/15 text-destructive"
      title={flag.message}
    >
      {flag.badge}
    </Badge>
  ) : (
    <Badge variant="secondary" className="ml-1 bg-amber-500/15 text-amber-600" title={flag.message}>
      {flag.badge}
    </Badge>
  );
}

function KpiFigure({ kind, value }: { kind: "number" | "loading" | "unavailable"; value: number }) {
  if (kind === "number") return <>{value.toLocaleString("en-US")}</>;
  return (
    <span
      className={`inline-block h-8 w-14 rounded bg-muted ${kind === "loading" ? "animate-pulse" : ""}`}
      aria-label={kind === "loading" ? "Loading" : "Unavailable"}
    />
  );
}

/** Runs-list KPIs and route rows. Numbers appear only after a successful load. */
export function DispatchRunsBoard({
  isError,
  isLoading,
  isFetching,
  hasData,
  errorMessage,
  onRetry,
  rows,
  canWrite,
  building,
  onOpenRun,
  onBuild,
  part = "all",
}: {
  isError: boolean;
  isLoading: boolean;
  isFetching?: boolean;
  hasData: boolean;
  errorMessage?: string | null;
  onRetry: () => void;
  rows: DispatchBoardRoute[];
  canWrite: boolean;
  building?: boolean;
  onOpenRun: (id: string) => void;
  onBuild: (routeId: string, code: string) => void;
  part?: "all" | "summary" | "table";
}) {
  const panels = dispatchListPanels({ isError, isLoading, hasData });
  const visible = useMemo(() => (panels.showRows ? rows : []), [panels.showRows, rows]);
  const totals = useMemo(() => {
    const all = visible.flatMap((r) => r.runs);
    return {
      enabled: visible.filter((r) => r.enabled).length,
      planned: all.filter((r) => r.status === "planned").length,
      pushed: all.filter((r) => r.status === "pushed").length,
      held: all.reduce((n, r) => n + r.stopsHeld, 0),
    };
  }, [visible]);
  const figure = panels.showKpiNumbers
    ? "number"
    : isLoading || isFetching
      ? "loading"
      : "unavailable";
  const byHub = useMemo(() => {
    const m = new Map<string, DispatchBoardRoute[]>();
    for (const r of visible) {
      const list = m.get(r.hub) ?? [];
      list.push(r);
      m.set(r.hub, list);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const summary = (
    <>
      {panels.showLoading && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          Loading dispatch runs
        </p>
      )}
      {panels.showError && (
        <DispatchListAlert
          message={errorMessage ?? "Dispatch runs could not be loaded."}
          stale={panels.showStaleNote}
          onRetry={onRetry}
        />
      )}
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6"
        aria-busy={!panels.showKpiNumbers}
      >
        <KpiCard
          label="Routes enabled"
          value={<KpiFigure kind={figure} value={totals.enabled} />}
          icon={<Truck className="w-4 h-4" />}
        />
        <KpiCard
          label="Runs planned"
          value={<KpiFigure kind={figure} value={totals.planned} />}
          icon={<Clock className="w-4 h-4" />}
        />
        <KpiCard
          label="Runs pushed"
          value={<KpiFigure kind={figure} value={totals.pushed} />}
          icon={<Send className="w-4 h-4" />}
        />
        <KpiCard
          label="Stops held"
          value={<KpiFigure kind={figure} value={totals.held} />}
          icon={<AlertTriangle className="w-4 h-4" />}
        />
      </div>
    </>
  );
  const table = (
    <>
      {panels.showLoading && (
        <Card className="p-6 text-sm text-muted-foreground">Loading routes…</Card>
      )}
      {byHub.map(([hub, list]) => (
        <div key={hub} className="mb-6">
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">{hub}</h2>
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Next cutoff</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((r) => (
                  <TableRow key={r.routeId}>
                    <TableCell>
                      <div className="font-medium break-words">{r.code}</div>
                      <div className="break-words text-xs text-muted-foreground">{r.name}</div>
                    </TableCell>
                    <TableCell>
                      {r.enabled ? (
                        <Badge variant="secondary" className="bg-primary/15 text-primary">
                          {r.autoPush ? "auto-push" : "enabled"}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">shadow</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.cutoff ? (
                        <div>
                          <div>{r.cutoff.timeLabel}</div>
                          <div className="text-xs text-muted-foreground">
                            ships {r.cutoff.runDates.join(", ") || "—"}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">no cutoff configured</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.runs.length === 0 && (
                          <span className="text-xs text-muted-foreground">none</span>
                        )}
                        {r.runs.map((run) => (
                          <button
                            key={run.id}
                            type="button"
                            className="text-xs underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2"
                            onClick={() => onOpenRun(run.id)}
                          >
                            <span className="mr-1">{run.runDate}</span>
                            <StatusBadge status={run.status} />
                            <ExceptionBadge flag={run.exception} />
                            {run.stopsHeld > 0 && (
                              <span className="ml-1 text-amber-600">{run.stopsHeld} held</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canWrite || building}
                        onClick={() => onBuild(r.routeId, r.code)}
                      >
                        {building ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Hammer className="w-4 h-4" />
                        )}
                        <span className="ml-2">Build now</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      ))}
    </>
  );
  return (
    <div data-testid="dispatch-runs-board">
      {part !== "table" && summary}
      {part !== "summary" && table}
    </div>
  );
}
