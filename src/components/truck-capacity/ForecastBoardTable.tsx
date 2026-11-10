import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UtilizationBar } from "./UtilizationBar";
import { EstPalletsTrigger } from "./EstPalletsTrigger";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type ForecastTableCutoff = {
  localDate: string;
  timeLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  daysAway: number;
  runDates: string[];
  windowFrom: string | null;
};

export type ForecastTableRow = {
  route_id: string;
  code: string;
  name: string;
  cutoff_count: number;
  next_cutoff: ForecastTableCutoff | null;
  final: number | null;
  current: number | null;
  method: string | null;
  mad: number | null;
  forecast_error: string | null;
  est_pallets: number | null;
  last_run: { date: string; capacity_frac: number } | null;
};

function fmtRunDates(dates: string[]) {
  if (!dates.length) return "—";
  return dates
    .map((d) => {
      const dt = new Date(`${d}T12:00:00Z`);
      return `${DOW[dt.getUTCDay()]} ${d.slice(5)}`;
    })
    .join(", ");
}

/** Route rows for the forecast board. Opening a route is a real button, not the row. */
export function ForecastBoardTable({
  rows,
  onSelectRoute,
}: {
  rows: ForecastTableRow[];
  onSelectRoute: (routeId: string) => void;
}) {
  return (
    <Table className="min-w-[1100px] table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[16%]">Route</TableHead>
          <TableHead className="w-[16%]">Next cutoff</TableHead>
          <TableHead className="w-[16%]">Ships on</TableHead>
          <TableHead className="w-[24%]">Projected fill</TableHead>
          <TableHead className="w-[12%]">On the books</TableHead>
          <TableHead className="w-[12%]">Last actual</TableHead>
          <TableHead className="w-[4%]">
            <span className="sr-only">Open</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow
            key={r.route_id}
            className="cursor-pointer"
            onClick={() => onSelectRoute(r.route_id)}
          >
            <TableCell className="align-top overflow-hidden">
              <div className="font-medium break-words">{r.code}</div>
              <div className="break-words text-xs text-muted-foreground">{r.name}</div>
            </TableCell>
            <TableCell className="align-top overflow-hidden text-xs">
              {r.next_cutoff ? (
                <>
                  <div className="font-medium">
                    {DOW[new Date(`${r.next_cutoff.localDate}T12:00:00Z`).getUTCDay()]}{" "}
                    {r.next_cutoff.timeLabel}
                  </div>
                  <div className="text-muted-foreground">
                    {r.next_cutoff.isToday
                      ? "today"
                      : r.next_cutoff.isTomorrow
                        ? "tomorrow"
                        : `in ${r.next_cutoff.daysAway}d`}
                    {r.cutoff_count > 1 && ` · ${r.cutoff_count} cutoffs`}
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">not configured</span>
              )}
            </TableCell>
            <TableCell className="align-top overflow-hidden text-xs">
              <div>{r.next_cutoff ? fmtRunDates(r.next_cutoff.runDates) : "—"}</div>
              {r.next_cutoff?.windowFrom && (
                <div className="text-muted-foreground">
                  orders counted through {r.next_cutoff.timeLabel}
                </div>
              )}
            </TableCell>
            <TableCell className="align-top overflow-hidden">
              <UtilizationBar value={r.final} secondary={r.current} className="min-w-0" />
              <div className="mt-1 text-xs text-muted-foreground">
                {r.method ? `${r.method}` : r.forecast_error ? "forecast error" : "no model"}
                {r.mad != null && ` ±${(r.mad * 100).toFixed(0)}%`}
              </div>
            </TableCell>
            <TableCell className="align-top overflow-hidden break-words text-sm">
              {r.current == null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                `${(r.current * 100).toFixed(0)}%`
              )}
              <EstPalletsTrigger code={r.code} estPallets={r.est_pallets} />
            </TableCell>
            <TableCell className="align-top overflow-hidden text-xs">
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
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="focus-visible:ring-2 focus-visible:ring-offset-2"
                aria-label={`Open route ${r.code}, ${r.name}`}
                data-testid={`open-route-${r.code}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectRoute(r.route_id);
                }}
              >
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
