import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2 } from "lucide-react";
import { getTruckScoreboardV1 } from "@/lib/truck-capacity.functions";

const WINDOWS = [
  { key: "frozen_holdout_v1", label: "Frozen holdout Aug 23 - Oct 12, 2026" },
  { key: "post_freeze", label: "Post-freeze from Oct 13, 2026" },
];
const HUBS = ["Birmingham", "Dallas", "Ocala", "All hubs"];

const frac = (n: number | null | undefined, d: number | null | undefined) => {
  const den = Number(d ?? 0);
  const num = Number(n ?? 0);
  return den ? `${num}/${den} (${Math.round((num / den) * 100)}%)` : "—";
};
const mae = (v: unknown) => (v == null ? "—" : `${Number(v).toFixed(1)} pts`);

export function ScoreboardV1Card() {
  const fn = useServerFn(getTruckScoreboardV1);
  const q = useQuery({ queryKey: ["truck-scoreboard-v1"], queryFn: () => fn() });
  const rows = (q.data?.rows ?? []) as Array<Record<string, any>>;

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">Fixed scoreboard v1 (frozen definition)</h3>
        <Badge variant="outline">Median = shadow</Badge>
      </div>
      {q.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : q.error ? (
        <p className="text-sm text-destructive">{(q.error as Error).message}</p>
      ) : (
        WINDOWS.map((w) => (
          <div key={w.key} className="space-y-1">
            <div className="text-sm font-medium">{w.label}</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hub</TableHead>
                  <TableHead>Paired route-days</TableHead>
                  <TableHead>Live within 5</TableHead>
                  <TableHead>Live within 10</TableHead>
                  <TableHead>Median within 5</TableHead>
                  <TableHead>Median within 10</TableHead>
                  <TableHead>Live MAE</TableHead>
                  <TableHead>Median MAE</TableHead>
                  <TableHead>Excluded (no live / no shadow)</TableHead>
                  <TableHead>Newest actual</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {HUBS.map((h) => {
                  const r = rows.find((x) => x.score_window === w.key && x.hub === h);
                  return (
                    <TableRow key={h} className={h === "All hubs" ? "font-medium" : undefined}>
                      <TableCell>{h}</TableCell>
                      <TableCell>{r ? frac(r.paired, r.route_days) : "—"}</TableCell>
                      <TableCell>{r ? frac(r.live_w5, r.paired) : "—"}</TableCell>
                      <TableCell>{r ? frac(r.live_w10, r.paired) : "—"}</TableCell>
                      <TableCell>{r ? frac(r.median_w5, r.paired) : "—"}</TableCell>
                      <TableCell>{r ? frac(r.median_w10, r.paired) : "—"}</TableCell>
                      <TableCell>{mae(r?.live_mae_pts)}</TableCell>
                      <TableCell>{mae(r?.median_mae_pts)}</TableCell>
                      <TableCell>{r ? `${r.excluded_no_live} / ${r.excluded_no_shadow}` : "—"}</TableCell>
                      <TableCell>{r?.newest_actual ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ))
      )}
      <p className="text-xs text-muted-foreground">
        Definition v1 (frozen Oct 16, 2026): one actual per route-day = mean departure fill from the tracker. Live = the forecast logged at least 1 day before the run date (latest such). Median = shadow per-route median of all earlier route-days known at that time. Both are scored on the same route-days. Within 5 / within 10 = absolute miss of at most 5 / 10 points of a full truck. The median is a shadow benchmark. It is logged and scored only. It is never served.
      </p>
    </Card>
  );
}
