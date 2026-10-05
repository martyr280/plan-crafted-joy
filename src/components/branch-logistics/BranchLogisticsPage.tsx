import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getBranchLogisticsReport } from "@/lib/branch-logistics.functions";
import { useAuth } from "@/lib/auth";
import { formatMinutes } from "@/lib/driver-time/reconciliation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Module = "driver-time" | "truck-capacity" | "dispatch";
const TITLES: Record<Module, string> = {
  "driver-time": "Driver Time",
  "truck-capacity": "Truck Capacity",
  dispatch: "Dispatch",
};

export function currentMonday(now = new Date()): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const x = new Date(local + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() - (x.getUTCDay() === 0 ? 6 : x.getUTCDay() - 1));
  return x.toISOString().slice(0, 10);
}

export function BranchLogisticsPage({ module }: { module: Module }) {
  const { user } = useAuth();
  const [weekStart, setWeekStart] = useState(() => currentMonday());
  const [routeId, setRouteId] = useState("");
  const [runId, setRunId] = useState("");
  const read = useServerFn(getBranchLogisticsReport);
  const q = useQuery({
    queryKey: ["branch-logistics", user?.id, module, weekStart, routeId, runId],
    queryFn: () =>
      read({
        data: { module, weekStart, ...(routeId ? { routeId } : {}), ...(runId ? { runId } : {}) },
      }),
    enabled: !!user,
  });
  const d = q.data;
  function shift(n: number) {
    const x = new Date(weekStart + "T00:00:00Z");
    x.setUTCDate(x.getUTCDate() + n * 7);
    setWeekStart(x.toISOString().slice(0, 10));
    setRunId("");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          {TITLES[module]}
          {d?.warehouse ? ` · ${d.warehouse}` : ""}
        </h1>
        <Badge variant="secondary">Read-only</Badge>
      </div>
      <div className="flex gap-2 items-center">
        <Button variant="outline" size="sm" onClick={() => shift(-1)}>
          <ChevronLeft className="w-4 h-4" />
          Previous week
        </Button>
        <span className="text-sm">Week of {weekStart}</span>
        <Button variant="outline" size="sm" onClick={() => shift(1)}>
          Next week
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
      {q.isPending ? (
        <p className="text-sm text-muted-foreground">Loading warehouse report…</p>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      ) : d ? (
        <>
          {d.module !== "driver-time" && (
            <label className="text-sm flex items-center gap-2">
              Route
              <select
                className="border rounded-md p-1 bg-background"
                value={routeId}
                onChange={(e) => {
                  setRouteId(e.target.value);
                  setRunId("");
                }}
              >
                <option value="">All warehouse routes</option>
                {d.routes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} · {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {d.module === "driver-time" && (
            <>
              <p className="text-sm">
                Warehouse time over {d.thresholdMinutes / 60} h:{" "}
                <strong>{formatMinutes(d.totals.flaggedMinutes)}</strong>
              </p>
              {d.drivers.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No driver records for this warehouse and week.
                </p>
              )}
              {d.drivers.map((r) => (
                <Card className="p-4 space-y-1" key={r.driverId}>
                  <h2 className="font-semibold">
                    {r.driverName} · {formatMinutes(r.flaggedMinutes)}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {r.hasOfficial ? "Official weekday report" : "Automated estimate"}
                  </p>
                  {r.events.map((e) => (
                    <p className="text-sm" key={e.id}>
                      {e.event_date} · {formatMinutes(e.duration_min)} ·{" "}
                      {e.address_name ?? "Location unresolved"}
                      {e.needs_review ? " · Needs review" : ""}
                    </p>
                  ))}
                </Card>
              ))}
            </>
          )}
          {d.module === "truck-capacity" && (
            <>
              <p className="text-sm">Latest actual in this week: {d.latestActual ?? "None"}</p>
              {d.runs.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No capacity actuals for this warehouse and week.
                </p>
              )}
              <Rows
                rows={d.runs}
                fields={["run_date", "route_id", "capacity_frac", "pallet_count"]}
              />
              {!routeId && (
                <p className="text-xs text-muted-foreground">
                  Pick a route to see its 28-day forecast.
                </p>
              )}
              {d.forecasts.map((f) => (
                <section key={f.routeId} className="space-y-2">
                  <h2 className="font-semibold">28-day forecast</h2>
                  <Rows
                    rows={f.value.days}
                    fields={["date", "predicted", "current", "capacity", "explanation"]}
                  />
                </section>
              ))}
            </>
          )}
          {d.module === "dispatch" && (
            <>
              <p className="text-sm">Ticket data last pulled: {d.pulledAt ?? "No cached report"}</p>
              {d.pulledAt && Date.now() - Date.parse(d.pulledAt) > 36 * 3600000 && (
                <p role="status" className="text-sm text-destructive">
                  Ticket data is older than 36 hours.
                </p>
              )}
              <h2 className="font-semibold">Upcoming runs by cutoff</h2>
              <Rows
                rows={d.board?.upcoming ?? []}
                fields={["route_code", "run_date", "tickets", "held", "missing_cube"]}
              />
              <h2 className="font-semibold">Tickets on departed runs</h2>
              <Rows
                rows={d.board?.stale ?? []}
                fields={["pick_ticket_no", "route_code", "run_date", "hold_reason"]}
              />
              <h2 className="font-semibold">Warehouse tickets</h2>
              <Rows
                rows={d.tickets}
                fields={[
                  "pick_ticket_no",
                  "route_code",
                  "customer_name",
                  "fulfillment_status",
                  "est_pallets",
                  "est_cube_ft",
                ]}
              />
              <h2 className="font-semibold">Runs</h2>
              <div className="flex flex-wrap gap-2">
                {d.runs.map((r) => (
                  <Button
                    variant={runId === r.id ? "default" : "outline"}
                    size="sm"
                    key={r.id}
                    onClick={() => setRunId(r.id)}
                  >
                    {r.route_code} · {r.run_date} · {r.status}
                  </Button>
                ))}
              </div>
              {runId && (
                <Rows
                  rows={d.stops}
                  fields={["pick_ticket_no", "customer_name", "hold_reason", "state"]}
                />
              )}
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function Rows({ rows, fields }: { rows: Record<string, unknown>[]; fields: string[] }) {
  return rows.length ? (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {fields.map((f) => (
              <th className="text-left p-2 font-medium" key={f}>
                {f.replaceAll("_", " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr className="border-t" key={r.id == null ? i : String(r.id)}>
              {fields.map((f) => (
                <td className="p-2" key={f}>
                  {r[f] == null ? "Unknown" : String(r[f])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">No rows for this warehouse.</p>
  );
}
