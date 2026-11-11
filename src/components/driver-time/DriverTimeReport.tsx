import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/shared/KpiCard";
import { destructiveTextClass, warningTextClass } from "@/components/driver-time/text-classes";
import { driverTimeReportPanels } from "@/lib/driver-time/report-panels";
import {
  costCoverageNotice,
  driverCostCoverage,
  estimatedCostFigure,
  type ReportDriver,
} from "@/lib/driver-time/cost-coverage";
import { formatMinutes } from "@/lib/driver-time/reconciliation";
import { DriverCard, hm } from "@/components/driver-time/DriverCard";

type Totals = {
  drivers: number;
  flaggedMinutes: number;
  needsReview: number;
  officialDrivers: number;
  estimatedCost?: number;
  driversWithoutRate?: number;
};

export function DriverTimeReport({
  isError,
  isLoading,
  isFetching,
  hasData,
  errorMessage,
  onRetry,
  totals,
  canManageDriverPay,
  hubGroups,
  drivers,
  thresholdMinutes,
  isAdmin,
}: {
  isError: boolean;
  isLoading: boolean;
  isFetching?: boolean;
  hasData: boolean;
  errorMessage?: string | null;
  onRetry: () => void;
  totals?: Totals | null;
  canManageDriverPay?: boolean;
  hubGroups?: Array<{
    hub: string;
    drivers: Array<{ driverId: string; flaggedMinutes: number } & Record<string, unknown>>;
    flaggedMinutes: number;
  }>;
  drivers?: ReportDriver[];
  thresholdMinutes?: number;
  isAdmin?: boolean;
}) {
  const panels = driverTimeReportPanels({ isError, isLoading, isFetching, hasData });
  const retryRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  // True while Retry was the last thing focused and nothing else has taken focus since.
  // Disabling or removing Retry drops focus to BODY without moving it anywhere useful.
  const retryOwnsFocus = useRef(false);
  useEffect(() => {
    if (!retryOwnsFocus.current || isFetching) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    retryOwnsFocus.current = false;
    if (!lost) return;
    if (panels.showError) retryRef.current?.focus();
    else summaryRef.current?.focus();
  }, [isFetching, panels.showError]);
  const groups = panels.showReport ? (hubGroups ?? []) : [];
  const coverage = driverCostCoverage(drivers);
  const coverageNotice = costCoverageNotice(coverage);
  const costLabel = estimatedCostFigure(canManageDriverPay, drivers);
  const costFigure = costLabel.partial ? (
    <span className={`text-lg font-semibold leading-snug ${warningTextClass}`}>
      {costLabel.text}
    </span>
  ) : (
    costLabel.text
  );
  const figure = (value: ReactNode) => {
    if (panels.showKpiNumbers) return value;
    return (
      <span
        className={`inline-block h-8 w-14 rounded bg-muted ${panels.showLoading ? "animate-pulse" : ""}`}
        aria-label={panels.showLoading ? "Loading" : "Unavailable"}
      />
    );
  };

  return (
    <div className="space-y-4">
      {panels.showError && (
        <Card className={`p-4 ${destructiveTextClass}`}>
          <p>
            Report unavailable: {errorMessage ?? "The week could not be loaded."} Hours have not
            been treated as zero.
          </p>
          <Button
            ref={retryRef}
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={!!isFetching}
            onFocus={() => {
              retryOwnsFocus.current = true;
            }}
            onBlur={(e) => {
              if (e.relatedTarget) retryOwnsFocus.current = false;
            }}
            onClick={() => {
              retryOwnsFocus.current = true;
              onRetry();
            }}
          >
            Retry
          </Button>
        </Card>
      )}
      {panels.showLoading && (
        <Card className="flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading week…
        </Card>
      )}
      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <KpiCard
          label="Drivers in report"
          value={figure(String(totals?.drivers ?? 0))}
          icon={<Users className="h-5 w-5" />}
        />
        <KpiCard
          label="Warehouse time (H:MM)"
          value={figure(totals ? formatMinutes(totals.flaggedMinutes) : "—")}
          icon={<Clock className="h-5 w-5" />}
        />
        <KpiCard
          label="Needs review"
          value={figure(String(totals?.needsReview ?? 0))}
          icon={<AlertTriangle className="h-5 w-5" />}
        />
        <KpiCard
          label="Estimated cost"
          value={figure(costFigure)}
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
      </div>
      {panels.showReport && canManageDriverPay && coverageNotice && (
        <Card className={`mb-4 border-warning/40 bg-warning/10 p-3 text-xs ${warningTextClass}`}>
          {coverageNotice}
        </Card>
      )}
      <Card
        ref={summaryRef}
        tabIndex={-1}
        data-testid="driver-time-summary"
        className={`p-3 text-sm focus-visible:outline focus-visible:outline-2 ${
          panels.showReport ? "" : "text-muted-foreground"
        }`}
      >
        {panels.showReport
          ? `${totals?.officialDrivers ?? 0} driver(s) have official weekday totals. All other totals are automated estimates. Excused, superseded and unresolved-location events remain visible but do not count. Times are shown in each warehouse’s local timezone.`
          : panels.showLoading
            ? "Week totals are still loading."
            : "Week totals are unavailable."}
      </Card>
      {panels.showReport && groups.length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground">
          No stored events or official report for this window. This does not prove zero hours.
        </Card>
      )}
      {groups.map((g) => (
        <Card key={g.hub} className="overflow-hidden p-0">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
            <div className="text-sm font-semibold">{g.hub}</div>
            <div className="text-xs text-muted-foreground">
              {g.drivers.length} driver{g.drivers.length === 1 ? "" : "s"} · {hm(g.flaggedMinutes)}{" "}
              reported
            </div>
          </div>
          <div className="space-y-4 p-3">
            {g.drivers.map((d) => (
              <DriverCard
                key={String(d.driverId)}
                driver={d as never}
                isAdmin={!!isAdmin}
                canViewPay={!!canManageDriverPay}
                thresholdMinutes={thresholdMinutes ?? 90}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
