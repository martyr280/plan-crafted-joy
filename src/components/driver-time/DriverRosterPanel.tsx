import { useEffect, useMemo, useRef, useState } from "react";
import { EyeOff, Loader2, RotateCcw, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/auth";
import { canManageDriverPay } from "@/lib/driver-time/access";
import { useDriverRoster, useSetDriverRosterVisibility } from "@/hooks/useDriverTime";
import {
  ROSTER_CONFLICT_MESSAGE,
  type ExcludedDriver,
  type RosterDriver,
} from "@/lib/driver-time/roster";

type RosterPayload = {
  active: RosterDriver[];
  hidden: ExcludedDriver[];
  settingsUpdatedAt: string | null;
  rosterError: string | null;
};

type FocusTarget = { key: string; fallback: "roster" | "hidden" | "conflict" };

const SOURCE_NOTE: Record<string, string | null> = {
  roster: null,
  events: "Not on the current Samsara roster; seen in stored warehouse events.",
  rates: "Not on the current Samsara roster; has a pay rate.",
};

/** Driver-pay managers only. Renders nothing (and loads nothing) for anyone else. */
export function DriverRosterPanel() {
  const { roles } = useAuth();
  if (!canManageDriverPay(roles)) return null;
  return <DriverRosterPanelInner />;
}

function DriverRosterPanelInner() {
  const q = useDriverRoster(true);
  const setVisibility = useSetDriverRosterVisibility();
  const [filter, setFilter] = useState("");
  const [confirming, setConfirming] = useState<RosterDriver | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const afterHideRef = useRef<FocusTarget | null>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const rosterHeadingRef = useRef<HTMLDivElement>(null);
  const hiddenHeadingRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const busy = setVisibility.isPending;

  const payload = q.data as RosterPayload | undefined;
  const active = useMemo(() => payload?.active ?? [], [payload]);
  const hidden = useMemo(() => payload?.hidden ?? [], [payload]);
  const f = filter.trim().toLowerCase();
  const matches = (d: { name: string; id: string }) =>
    !f || d.name.toLowerCase().includes(f) || d.id.toLowerCase().includes(f);
  const shownActive = active.filter(matches);
  const shownHidden = hidden.filter(matches);
  const isConflict = failure === ROSTER_CONFLICT_MESSAGE;

  // Runs after the refreshed list renders, so the moved row's button exists.
  useEffect(() => {
    if (!focusTarget) return;
    const el = actionRefs.current.get(focusTarget.key);
    if (el?.isConnected) el.focus();
    else if (focusTarget.fallback === "conflict") refreshRef.current?.focus();
    else if (focusTarget.fallback === "hidden") hiddenHeadingRef.current?.focus();
    else rosterHeadingRef.current?.focus();
    setFocusTarget(null);
  }, [focusTarget, payload]);

  const refFor = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) actionRefs.current.set(key, el);
    else actionRefs.current.delete(key);
  };

  async function change(driver: { id: string; name: string }, hide: boolean): Promise<FocusTarget> {
    setFailure(null);
    try {
      const result = await setVisibility.mutateAsync({
        driverId: driver.id,
        hidden: hide,
        expectedUpdatedAt: payload?.settingsUpdatedAt ?? null,
      });
      const refreshed = (await q.refetch()) as { data?: RosterPayload };
      const back = refreshed.data?.active.some((d) => d.id === driver.id) ?? false;
      if (hide) {
        setAnnouncement(
          result.changed
            ? `Hid ${driver.name}. Their rates, events and history are kept.`
            : `${driver.name} was already hidden.`,
        );
        return { key: `restore:${driver.id}`, fallback: "hidden" };
      }
      const where = back
        ? ""
        : " They will reappear on the roster once Samsara lists them as a licensed, active driver.";
      setAnnouncement(
        result.changed
          ? `Restored ${driver.name}.${where}`
          : `${driver.name} was already restored.${where}`,
      );
      return { key: `hide:${driver.id}`, fallback: "hidden" };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Could not update the driver list.";
      setFailure(message);
      setAnnouncement("");
      return message === ROSTER_CONFLICT_MESSAGE
        ? { key: "", fallback: "conflict" }
        : { key: `${hide ? "hide" : "restore"}:${driver.id}`, fallback: "roster" };
    }
  }

  async function refreshAfterConflict() {
    const result = (await q.refetch()) as { isError?: boolean };
    if (result.isError) {
      setAnnouncement("Could not refresh the driver list.");
      return;
    }
    setFailure(null);
    setAnnouncement("Driver list refreshed. Review it and try again.");
    setFocusTarget({ key: "", fallback: "roster" });
  }

  return (
    <Card className="p-4 space-y-3" data-testid="driver-roster-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div
            ref={rosterHeadingRef}
            tabIndex={-1}
            className="font-semibold text-sm focus-visible:outline focus-visible:outline-2"
            data-testid="driver-roster-heading"
          >
            Driver roster
          </div>
          <p className="text-xs text-muted-foreground">
            Drivers come from Samsara. Hiding someone takes them off Driver rates and the weekly
            report. Their rates, events and history are kept, and Restore brings them back.
          </p>
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Filter roster"
            className="pl-8 h-9 w-full"
            placeholder="Filter roster"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only" data-testid="driver-roster-live">
        {announcement}
      </p>

      {failure && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive-text">{failure}</p>
          {isConflict && (
            <Button
              ref={refreshRef}
              type="button"
              size="sm"
              variant="outline"
              disabled={q.isFetching}
              onClick={() => void refreshAfterConflict()}
            >
              Refresh list
            </Button>
          )}
        </div>
      )}

      {payload?.rosterError && (
        <p className="text-xs text-destructive-text">
          Samsara driver list unavailable ({payload.rosterError}). Showing drivers Driver Time has
          already seen.
        </p>
      )}
      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading roster…
        </div>
      )}
      {q.isError && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive-text">
            Roster unavailable: {(q.error as Error).message}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!q.isLoading && !q.isError && payload && (
        <>
          <ul className="rounded-md border divide-y" aria-label="Drivers on the roster">
            {shownActive.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="min-w-0 sm:flex-1">
                  <div className="break-words font-medium">{d.name}</div>
                  <div className="text-xs text-muted-foreground break-all">
                    Samsara id {d.id}
                    {SOURCE_NOTE[d.source] ? ` · ${SOURCE_NOTE[d.source]}` : ""}
                  </div>
                </div>
                <Button
                  ref={refFor(`hide:${d.id}`)}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={busy}
                  aria-label={`Hide ${d.name}`}
                  onClick={(e) => {
                    openerRef.current = e.currentTarget;
                    setConfirming(d);
                  }}
                >
                  <EyeOff className="h-4 w-4" aria-hidden="true" /> Hide
                </Button>
              </li>
            ))}
            {!shownActive.length && (
              <li className="px-3 py-2 text-sm text-muted-foreground">
                {active.length
                  ? "No drivers on the roster match this filter."
                  : "No drivers on the roster."}
              </li>
            )}
          </ul>

          <div className="space-y-2">
            <div
              ref={hiddenHeadingRef}
              tabIndex={-1}
              className="font-semibold text-sm focus-visible:outline focus-visible:outline-2"
              data-testid="driver-roster-hidden-heading"
            >
              Hidden drivers ({hidden.length})
            </div>
            <ul className="rounded-md border divide-y" aria-label="Hidden drivers">
              {shownHidden.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="min-w-0 sm:flex-1">
                    <div className="break-words font-medium">{d.name}</div>
                    <div className="text-xs text-muted-foreground break-all">
                      Samsara id {d.id}
                      {d.alsoMatchesPattern
                        ? " · Also matches a detection name pattern, so Restore alone will not bring them back."
                        : ""}
                    </div>
                  </div>
                  <Button
                    ref={refFor(`restore:${d.id}`)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={busy}
                    aria-label={`Restore ${d.name}`}
                    onClick={async () => setFocusTarget(await change(d, false))}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" /> Restore
                  </Button>
                </li>
              ))}
              {!shownHidden.length && (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  {hidden.length ? "No hidden drivers match this filter." : "No hidden drivers."}
                </li>
              )}
            </ul>
          </div>
        </>
      )}

      <AlertDialog
        open={confirming != null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(null);
        }}
      >
        <AlertDialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-lg"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const after = afterHideRef.current;
            afterHideRef.current = null;
            if (after) {
              setFocusTarget(after);
              return;
            }
            const opener = openerRef.current;
            (opener?.isConnected ? opener : rosterHeadingRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              Hide {confirming?.name ?? "driver"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They come off Driver rates and the weekly report, including past weeks. Their pay
              rates, warehouse events and capacity history are kept. You can restore them from
              Hidden drivers at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={async (e) => {
                e.preventDefault();
                if (!confirming || busy) return;
                // Focus moves only after the dialog's focus trap has released.
                afterHideRef.current = await change(confirming, true);
                setConfirming(null);
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Hide driver
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
