// All-routes forecast board, grouped by hub. Joe's default landing view:
// every active route, its next cutoff, and how full that run is projected to be.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ChevronRight, Clock, RefreshCw } from "lucide-react";
import { getForecastBoard } from "@/lib/truck-capacity.functions";
import { UtilizationBar } from "./UtilizationBar";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtRunDates(dates: string[]) {
  if (!dates.length) return "—";
  return dates
    .map((d) => {
      const dt = new Date(`${d}T12:00:00Z`);
      return `${DOW[dt.getUTCDay()]} ${d.slice(5)}`;
    })
    .join(", ");
}

export function ForecastBoard({ onSelectRoute }: { onSelectRoute: (routeId: string) => void }) {
  const fetchBoard = useServerFn(getForecastBoard);
  const q = useQuery({
    queryKey: ["truck-forecast-board"],
    queryFn: () => fetchBoard({ data: {} }),
    staleTime: 60_000,
  });

  const byHub = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const hubs = q.data?.hubs ?? [];
    return hubs.map((hub) => ({ hub, rows: rows.filter((r) => r.hub === hub) }));
  }, [q.data]);

  const snap = q.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground flex items-center gap-2">
          <Clock className="h-4 w-4" />
          {snap?.snapshot_at ? (
            <>
              P21 snapshot {new Date(snap.snapshot_at).toLocaleString()}
              {snap.snapshot_age_hours != null && <span className="ml-1">({snap.snapshot_age_hours}h ago)</span>}
            </>
          ) : (
            "No P21 snapshot yet"
          )}
          {snap?.snapshot_stale && (
            <Badge variant="destructive" className="ml-1 text-xs">
              <AlertTriangle className="mr-1 h-3 w-3" /> Stale
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {q.isLoading && <Card className="p-4 text-sm text-muted-foreground">Building board across all active routes…</Card>}
      {q.error && <Card className="p-4 text-sm text-destructive">{(q.error as Error).message}</Card>}

      {!!snap?.routes_without_cutoffs.length && (
        <Card className="p-3 text-xs text-muted-foreground">
          No cutoff configured for: {snap.routes_without_cutoffs.join(", ")} — add them in Settings → Route cutoffs so
          the board can tell you which orders count toward the next run.
        </Card>
      )}

      {byHub.map(({ hub, rows }) => (
        <Card key={hub} className="p-0 overflow-hidden">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
            <div className="text-sm font-semibold">{hub}</div>
            <div className="text-xs text-muted-foreground">{rows.length} routes</div>
          </div>
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[16%]">Route</TableHead>
                <TableHead className="w-[16%]">Next cutoff</TableHead>
                <TableHead className="w-[16%]">Runs</TableHead>
                <TableHead className="w-[24%]">Projected fill</TableHead>
                <TableHead className="w-[12%]">On the books</TableHead>
                <TableHead className="w-[12%]">Last actual</TableHead>
                <TableHead className="w-[4%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.route_id}
                  className="cursor-pointer"
                  onClick={() => onSelectRoute(r.route_id)}
                >
                  <TableCell className="align-top">
                    <div className="font-medium">{r.code}</div>
                    <div className="truncate text-xs text-muted-foreground">{r.name}</div>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {r.next_cutoff ? (
                      <>
                        <div className="font-medium">
                          {DOW[new Date(`${r.next_cutoff.localDate}T12:00:00Z`).getUTCDay()]} {r.next_cutoff.timeLabel}
                        </div>

                        <div className="text-muted-foreground">
                          {r.next_cutoff.isToday ? "today" : r.next_cutoff.isTomorrow ? "tomorrow" : `in ${r.next_cutoff.daysAway}d`}
                          {r.cutoff_count > 1 && ` · ${r.cutoff_count} cutoffs`}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">not configured</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div>{r.next_cutoff ? fmtRunDates(r.next_cutoff.runDates) : "—"}</div>
                    {r.next_cutoff?.windowFrom && (
                      <div className="text-muted-foreground">
                        orders counted through {r.next_cutoff.label}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <UtilizationBar value={r.final} secondary={r.current} />
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {r.method ? `${r.method}` : r.forecast_error ? "forecast error" : "no model"}
                      {r.mad != null && ` ±${(r.mad * 100).toFixed(0)}%`}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    {r.current == null ? <span className="text-muted-foreground">—</span> : `${(r.current * 100).toFixed(0)}%`}
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {r.last_run ? (
                      <>
                        <div>{(r.last_run.capacity_frac * 100).toFixed(0)}%</div>
                        <div className="text-muted-foreground">{r.last_run.date}</div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ))}
    </div>
  );
}
