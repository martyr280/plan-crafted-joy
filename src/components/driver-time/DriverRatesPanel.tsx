import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { canManageDriverPay } from "@/lib/driver-time/access";
import { useAddDriverPayRate, useDriverPayRates, useUpdateDriverPayRate } from "@/hooks/useDriverTime";
import { dateStrInTz } from "@/lib/driver-time/tz";
import { isValidDateStr, parseHourlyRate, rateHistory, rateOn, type PayRateRow } from "@/lib/driver-time/rates";

export const rateMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const q = useDriverPayRates(true);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const today = dateStrInTz(new Date());

  const drivers: Driver[] = (q.data as any)?.drivers ?? [];
  const rates: PayRateRow[] = (q.data as any)?.rates ?? [];
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? drivers.filter((d) => d.name.toLowerCase().includes(f)) : drivers;
  }, [drivers, filter]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  return (
    <Card className="p-4 space-y-3" data-testid="driver-rates-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-semibold text-sm" data-testid="driver-rates-heading">Driver rates</div>
          <p className="text-xs text-muted-foreground">
            Each day's cost uses the newest rate that started on or before that day. Adding a rate keeps all earlier rates.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input aria-label="Filter drivers" className="pl-8 h-9 w-56" placeholder="Filter drivers" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>

      {(q.data as any)?.rosterError && (
        <p className="text-xs text-destructive">
          Samsara driver list unavailable ({(q.data as any).rosterError}). Showing drivers Driver Time has already seen.
        </p>
      )}
      {q.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading rates…</div>}
      {q.isError && <p className="text-sm text-destructive">Rates unavailable: {(q.error as Error).message}</p>}

      {!q.isLoading && !q.isError && (
        <div className="rounded-md border divide-y">
          {shown.map((d) => {
            const history = rateHistory(rates, d.id);
            const current = rateOn(rates, d.id, today);
            const isOpen = open.has(d.id);
            return (
              <div key={d.id} className="px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium min-w-40 flex-1">{d.name}</span>
                  <span className="text-muted-foreground text-xs min-w-48">
                    {current ? <>Current <strong className="text-foreground">{rateMoney(Number(current.hourly_rate))}/hr</strong> since {current.effective_date}</> : "No rate in effect today"}
                  </span>
                  <Button variant="ghost" size="sm" disabled={!history.length} onClick={() => toggle(d.id)} aria-expanded={isOpen}>
                    History ({history.length})
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditing({ mode: "add", driver: d })}>
                    <Plus className="h-4 w-4" /> Add rate
                  </Button>
                </div>
                {isOpen && (
                  <ul className="mt-2 ml-2 space-y-1">
                    {history.map((r) => (
                      <li key={r.id} className="flex items-center gap-3 text-xs">
                        <span className="w-24">{r.effective_date}</span>
                        <span className="w-24 font-medium">{rateMoney(Number(r.hourly_rate))}/hr</span>
                        {r.effective_date > today && <Badge variant="secondary">Starts later</Badge>}
                        {current?.id === r.id && <Badge>Current</Badge>}
                        <Button variant="ghost" size="sm" className="h-7" aria-label={`Edit rate from ${r.effective_date}`}
                          onClick={() => setEditing({ mode: "edit", driver: d, row: r as any })}>
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {!shown.length && <div className="px-3 py-2 text-sm text-muted-foreground">No drivers found.</div>}
        </div>
      )}

      {editing && <RateDialog key={editing.mode === "edit" ? editing.row.id : `add:${editing.driver.id}`} editing={editing} today={today} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RateDialog({ editing, today, onClose }: { editing: Editing; today: string; onClose: () => void }) {
  const add = useAddDriverPayRate();
  const update = useUpdateDriverPayRate();
  const initialRate = editing.mode === "edit" ? Number(editing.row.hourly_rate).toFixed(2) : "";
  const initialDate = editing.mode === "edit" ? editing.row.effective_date : today;
  const [rate, setRate] = useState(initialRate);
  const [date, setDate] = useState(initialDate);
  const [confirming, setConfirming] = useState(false);
  const busy = add.isPending || update.isPending;

  const parsed = parseHourlyRate(rate);
  const dateOk = isValidDateStr(date);
  const unchanged = editing.mode === "edit" && parsed.ok && parsed.value === Number(editing.row.hourly_rate) && date === editing.row.effective_date;
  const error = rate && !parsed.ok ? parsed.error : !dateOk ? "Pick an effective date." : null;

  async function submit() {
    if (!parsed.ok || !dateOk || busy) return;
    try {
      if (editing.mode === "add") {
        await add.mutateAsync({ driverId: editing.driver.id, driverName: editing.driver.name, hourlyRate: parsed.value, effectiveDate: date });
        toast.success(`Added ${rateMoney(parsed.value)}/hr for ${editing.driver.name} from ${date}`);
      } else {
        await update.mutateAsync({ id: editing.row.id, hourlyRate: parsed.value, effectiveDate: date, expectedUpdatedAt: editing.row.updated_at });
        toast.success(`Rate updated for ${editing.driver.name}`);
      }
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not save the rate");
      setConfirming(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing.mode === "add" ? "Add rate" : "Edit rate"} · {editing.driver.name}</DialogTitle>
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
              <Input id="rate-amount" inputMode="decimal" placeholder="24.50" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="rate-date">Effective date</Label>
              <Input id="rate-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              {dateOk && date > today && <p className="text-xs text-muted-foreground">Future date: applies from {date}; earlier days keep the old rate.</p>}
            </div>
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          </div>
        ) : (
          editing.mode === "edit" && parsed.ok && (
            <p className="text-sm">
              Change <strong>{rateMoney(Number(editing.row.hourly_rate))}/hr from {editing.row.effective_date}</strong> to{" "}
              <strong>{rateMoney(parsed.value)}/hr from {date}</strong>?
            </p>
          )
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => (confirming ? setConfirming(false) : onClose())}>
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
            <Button disabled={!parsed.ok || !dateOk || unchanged} onClick={() => setConfirming(true)}>Review change</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
