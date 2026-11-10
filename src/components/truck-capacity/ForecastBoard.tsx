// All-routes forecast board, grouped by hub. Joe's default landing view:
// every active route, its next cutoff, and how full that run is projected to be.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { getForecastBoard } from "@/lib/truck-capacity.functions";
import { ForecastBoardTable } from "./ForecastBoardTable";

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
    // Joe's ask: inside a hub, the truck that cuts off soonest goes first;
    // routes with no cutoff configured sink to the bottom, same as cutoffSortKey.
    const keyOf = (r: (typeof rows)[number]) =>
      r.next_cutoff ? new Date(r.next_cutoff.atUtc).getTime() : Number.MAX_SAFE_INTEGER;
    return hubs.map((hub) => ({
      hub,
      rows: rows
        .filter((r) => r.hub === hub)
        .slice()
        .sort((a, b) => keyOf(a) - keyOf(b) || a.code.localeCompare(b.code)),
    }));
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
              {snap.snapshot_age_hours != null && (
                <span className="ml-1">({snap.snapshot_age_hours}h ago)</span>
              )}
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

      {q.isLoading && (
        <Card className="p-4 text-sm text-muted-foreground">
          Building board across all active routes…
        </Card>
      )}
      {q.error && (
        <Card className="p-4 text-sm text-destructive-text">{(q.error as Error).message}</Card>
      )}

      {!!snap?.routes_without_cutoffs.length && (
        <Card className="p-3 text-xs text-muted-foreground">
          No cutoff configured for: {snap.routes_without_cutoffs.join(", ")} — add them in Settings
          → Route cutoffs so the board can tell you which orders count toward the next run.
        </Card>
      )}

      {byHub.map(({ hub, rows }) => (
        <Card key={hub} className="p-0 overflow-hidden">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
            <div className="text-sm font-semibold">{hub}</div>
            <div className="text-xs text-muted-foreground">{rows.length} routes</div>
          </div>
          <ForecastBoardTable rows={rows} onSelectRoute={onSelectRoute} />
        </Card>
      ))}
    </div>
  );
}
