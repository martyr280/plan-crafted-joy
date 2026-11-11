import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { canManageDriverPay } from "@/lib/driver-time/access";
import {
  useAddDriverPayRate,
  useDriverPayRates,
  useUpdateDriverPayRate,
} from "@/hooks/useDriverTime";
import { dateStrInTz } from "@/lib/driver-time/tz";
import {
  STALE_PAY_RATE_MESSAGE,
  isValidDateStr,
  parseHourlyRate,
  rateHistory,
  rateOn,
  type PayRateRow,
} from "@/lib/driver-time/rates";

export const rateMoney = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

type Driver = { id: string; name: string; source: string };
type Editing =
  | { mode: "add"; driver: Driver }
  | { mode: "edit"; driver: Driver; row: PayRateRow & { id: string; updated_at: string } };

/** Driver-pay managers only. Renders nothing (and loads nothing) for anyone else. */
export function DriverRatesPanel() {
  const { roles } = useAuth();
  if (!canManageDriverPay(roles)) return null;
  return <DriverRatesPanelInner />;
}

function DriverRatesPanelInner() {
  const [showHidden, setShowHidden] = useState(false);
  const q = useDriverPayRates(true, showHidden);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const openEditor = (next: Editing, opener: HTMLElement) => {
    openerRef.current = opener;
    setEditing(next);
  };
  // The dialog has no DialogTrigger, so Radix has nothing to restore focus to on close.
  const returnFocus = () => {
    const opener = openerRef.current;
    openerRef.current = null;
    (opener?.isConnected ? opener : headingRef.current)?.focus();
  };
  const today = dateStrInTz(new Date());

  const payload = q.data as
    | {
        drivers?: Driver[];
        excludedDrivers?: Array<{ id: string; name: string }>;
        rates?: PayRateRow[];
        rosterError?: string | null;
      }
    | undefined;
  const drivers: Driver[] = useMemo(
    () => [
      ...(payload?.drivers ?? []),
      ...(showHidden
        ? (payload?.excludedDrivers ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            source: "hidden",
          }))
        : []),
    ],
    [payload, showHidden],
  );
  const rates: PayRateRow[] = payload?.rates ?? [];
  const rosterError = payload?.rosterError;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? drivers.filter((d) => d.name.toLowerCase().includes(f)) : drivers;
  }, [drivers, filter]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Card className="p-4 space-y-3" data-testid="driver-rates-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div
            ref={headingRef}
            tabIndex={-1}
            className="font-semibold text-sm focus-visible:outline focus-visible:outline-2"
            data-testid="driver-rates-heading"
          >
            Driver rates
          </div>
          <p className="text-xs text-muted-foreground">
            Each day's cost uses the newest rate that started on or before that day. Adding a rate
            keeps all earlier rates.
          </p>
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Filter drivers"
            className="pl-8 h-9 w-full"
            placeholder="Filter drivers"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={showHidden}
          onChange={(e) => setShowHidden(e.target.checked)}
        />
        <span>Show hidden drivers (to review their rate history)</span>
      </label>

      {rosterError && (
        <p className="text-xs text-destructive-text">
          Samsara driver list unavailable ({rosterError}). Showing drivers Driver Time has already
          seen.
        </p>
      )}
      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading rates…
        </div>
      )}
      {q.isError && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive-text">
            Rates unavailable: {(q.error as Error).message}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!q.isLoading && !q.isError && (
        <div className="rounded-md border divide-y">
          {shown.map((d) => {
            const history = rateHistory(rates, d.id);
            const current = rateOn(rates, d.id, today);
            const isOpen = open.has(d.id);
            return (
              <div key={d.id} className="px-3 py-2 text-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
                  <span
                    className="w-full break-words font-medium sm:min-w-0 sm:flex-1"
                    title={d.name}
                  >
                    {d.name}
                    {d.source === "hidden" && (
                      <Badge variant="secondary" className="ml-2">
                        Hidden
                      </Badge>
                    )}
                  </span>
                  <span className="w-full text-muted-foreground text-xs sm:w-auto sm:min-w-48">
                    {current ? (
                      <>
                        Current{" "}
                        <strong className="text-foreground">
                          {rateMoney(Number(current.hourly_rate))}/hr
                        </strong>{" "}
                        since {current.effective_date}
                      </>
                    ) : (
                      "No rate in effect today"
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto whitespace-normal text-left"
                    disabled={!history.length}
                    onClick={() => toggle(d.id)}
                    aria-expanded={isOpen}
                  >
                    History for {d.name} ({history.length})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto whitespace-normal text-left"
                    onClick={(e) => openEditor({ mode: "add", driver: d }, e.currentTarget)}
                  >
                    <Plus className="h-4 w-4" /> Add rate for {d.name}
                  </Button>
                </div>
                {isOpen && (
                  <ul className="mt-2 ml-2 space-y-1">
                    {history.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                      >
                        <span>{r.effective_date}</span>
                        <span className="font-medium">{rateMoney(Number(r.hourly_rate))}/hr</span>
                        {r.effective_date > today && (
                          <Badge variant="secondary">Starts later</Badge>
                        )}
                        {current?.id === r.id && <Badge>Current</Badge>}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          aria-label={`Edit rate for ${d.name} from ${r.effective_date}`}
                          onClick={(e) => {
                            if (!r.id || !r.updated_at) return;
                            openEditor(
                              {
                                mode: "edit",
                                driver: d,
                                row: { ...r, id: r.id, updated_at: r.updated_at },
                              },
                              e.currentTarget,
                            );
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {!shown.length && drivers.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No drivers on the roster yet.
            </div>
          )}
          {!shown.length && drivers.length > 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground flex flex-wrap items-center gap-2">
              <span>No drivers match this filter.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => setFilter("")}>
                Clear filter
              </Button>
            </div>
          )}
        </div>
      )}

      {editing && (
        <RateDialog
          key={editing.mode === "edit" ? editing.row.id : `add:${editing.driver.id}`}
          editing={editing}
          today={today}
          onClose={() => setEditing(null)}
          onCloseAutoFocus={returnFocus}
          onRefresh={async () => {
            const result = (await q.refetch()) as {
              isSuccess?: boolean;
              isError?: boolean;
              data?: { rates?: PayRateRow[] };
            };
            if (result.isError || !result.isSuccess) {
              throw new Error("Could not refresh this rate.");
            }
            const next = result.data?.rates;
            if (!next) throw new Error("Could not refresh this rate.");
            return next;
          }}
        />
      )}
    </Card>
  );
}

function RateDialog({
  editing,
  today,
  onClose,
  onCloseAutoFocus,
  onRefresh,
}: {
  editing: Editing;
  today: string;
  onClose: () => void;
  onCloseAutoFocus: () => void;
  onRefresh: () => Promise<PayRateRow[]>;
}) {
  const add = useAddDriverPayRate();
  const update = useUpdateDriverPayRate();
  const initialRate = editing.mode === "edit" ? Number(editing.row.hourly_rate).toFixed(2) : "";
  const initialDate = editing.mode === "edit" ? editing.row.effective_date : today;
  const [rate, setRate] = useState(initialRate);
  const [date, setDate] = useState(initialDate);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState(
    editing.mode === "edit"
      ? {
          hourlyRate: Number(editing.row.hourly_rate),
          effectiveDate: editing.row.effective_date,
          updatedAt: editing.row.updated_at,
        }
      : null,
  );
  const reviewRef = useRef<HTMLParagraphElement>(null);
  const refreshLock = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const busy = add.isPending || update.isPending;

  const parsed = parseHourlyRate(rate);
  const dateOk = isValidDateStr(date);
  const unchanged =
    editing.mode === "edit" &&
    baseline != null &&
    parsed.ok &&
    parsed.value === baseline.hourlyRate &&
    date === baseline.effectiveDate;
  const rateError = rate && !parsed.ok ? parsed.error : null;
  const dateError = !dateOk ? "Pick an effective date." : null;

  useEffect(() => {
    if (confirming) reviewRef.current?.focus();
  }, [confirming]);

  async function submit() {
    if (!parsed.ok || !dateOk || busy) return;
    try {
      if (editing.mode === "add") {
        await add.mutateAsync({
          driverId: editing.driver.id,
          driverName: editing.driver.name,
          hourlyRate: parsed.value,
          effectiveDate: date,
        });
        toast.success(
          `Added ${rateMoney(parsed.value)}/hr for ${editing.driver.name} from ${date}`,
        );
      } else {
        await update.mutateAsync({
          id: editing.row.id,
          hourlyRate: parsed.value,
          effectiveDate: date,
          expectedUpdatedAt: baseline?.updatedAt ?? "",
        });
        toast.success(`Rate updated for ${editing.driver.name}`);
      }
      onClose();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Could not save the rate";
      toast.error(message);
      setSaveError(message);
      setConfirming(false);
    }
  }

  async function refreshKeptValues() {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    setRefreshNote("Refreshing this rate.");
    try {
      let latest: PayRateRow[];
      try {
        latest = await onRefresh();
      } catch {
        setRefreshNote("Could not refresh this rate. The draft and the conflict are unchanged.");
        return;
      }
      if (editing.mode !== "edit") return;
      const row = latest.find((r) => r.id === editing.row.id);
      if (!row?.updated_at || row.hourly_rate == null || !row.effective_date) {
        setRefreshNote(
          "This rate was not in the refreshed list. The draft and the conflict are unchanged.",
        );
        return;
      }
      setBaseline({
        hourlyRate: Number(row.hourly_rate),
        effectiveDate: row.effective_date,
        updatedAt: row.updated_at,
      });
      setSaveError(null);
      setRefreshNote(null);
      setConfirming(true);
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {editing.mode === "add" ? "Add rate" : "Edit rate"} · {editing.driver.name}
          </DialogTitle>
          <DialogDescription>
            {editing.mode === "add"
              ? "Adds a new rate starting on the effective date. Earlier rates stay in the history."
              : "Changes this one history row. Cost estimates for every week it covers will change."}
          </DialogDescription>
        </DialogHeader>

        {!confirming ? (
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="rate-amount">Hourly rate (USD)</Label>
              <Input
                id="rate-amount"
                inputMode="decimal"
                placeholder="24.50"
                value={rate}
                aria-invalid={Boolean(rateError)}
                aria-describedby={rateError ? "rate-error" : undefined}
                onChange={(e) => setRate(e.target.value)}
              />
              {rateError && (
                <p id="rate-error" className="text-xs text-destructive-text" role="alert">
                  {rateError}
                </p>
              )}
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rate-date">Effective date</Label>
              <Input
                id="rate-date"
                type="date"
                value={date}
                aria-invalid={Boolean(dateError)}
                aria-describedby={dateError ? "date-error" : undefined}
                onChange={(e) => setDate(e.target.value)}
              />
              {dateOk && date > today && (
                <p className="text-xs text-muted-foreground">
                  Future date: applies from {date}; earlier days keep the old rate.
                </p>
              )}
              {dateError && (
                <p id="date-error" className="text-xs text-destructive-text" role="alert">
                  {dateError}
                </p>
              )}
            </div>
            {refreshNote && (
              <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {refreshNote}
              </p>
            )}
            {saveError && (
              <div className="space-y-2" role="alert">
                <p className="text-xs text-destructive-text">{saveError}</p>
                {saveError === STALE_PAY_RATE_MESSAGE && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={refreshing}
                    onClick={() => void refreshKeptValues()}
                  >
                    Refresh this rate
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          editing.mode === "edit" &&
          parsed.ok && (
            <p
              ref={reviewRef}
              tabIndex={-1}
              role="status"
              className="text-sm focus-visible:outline focus-visible:outline-2"
            >
              Change{" "}
              <strong>
                {rateMoney(baseline?.hourlyRate ?? 0)}/hr from {baseline?.effectiveDate}
              </strong>{" "}
              to{" "}
              <strong>
                {rateMoney(parsed.value)}/hr from {date}
              </strong>
              ? Review this change before saving.
            </p>
          )
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => (confirming ? setConfirming(false) : onClose())}
          >
            {confirming ? "Back" : "Cancel"}
          </Button>
          {editing.mode === "add" ? (
            <Button disabled={busy || !parsed.ok || !dateOk} onClick={submit}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add rate
            </Button>
          ) : confirming ? (
            <Button disabled={busy} onClick={submit}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirm change
            </Button>
          ) : (
            <Button
              disabled={!parsed.ok || !dateOk || unchanged}
              onClick={() => setConfirming(true)}
            >
              Review change
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
