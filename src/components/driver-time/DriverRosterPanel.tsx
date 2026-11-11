import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, EyeOff, Info, Loader2, RotateCcw, Search } from "lucide-react";
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
import { useActionFocus } from "@/hooks/useActionFocus";
import {
  ROSTER_CONFLICT_MESSAGE,
  type ExcludedDriver,
  type RosterDriver,
} from "@/lib/driver-time/roster";
import { hiddenFromFor } from "@/lib/driver-time/exclusions";

type RosterPayload = {
  active: RosterDriver[];
  hidden: ExcludedDriver[];
  /** Absent from older servers; then a name rule can't be verified. */
  patternMatchedIds?: string[];
  settingsUpdatedAt: string | null;
  rosterError: string | null;
};

type Fallback = "roster" | "hidden" | "conflict" | "status";
/** owner: an action claimed via useActionFocus; without it focus moves unconditionally (post-dialog). */
type FocusTarget = { key: string; fallback: Fallback; owner?: number };
type Notice = { text: string; tone: "ok" | "warn"; needsRefresh?: boolean };
type Verify = { id: string; name: string; changed: boolean };

/** "Nov 9, 2026" for a YYYY-MM-DD date. */
function weekLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const SOURCE_NOTE: Record<string, string | null> = {
  roster: null,
  events: "Not on the current Samsara roster; seen in stored warehouse events.",
  rates: "Not on the current Samsara roster; has a pay rate.",
};

const UNVERIFIED =
  "Couldn't refresh the driver list, so their current visibility is unverified. Refresh the list to check.";

/** Result of a Restore, judged only from a successful fresh read (null = the read failed). */
function restoreNotice(v: Verify, fresh: RosterPayload | null): Notice {
  const { id, name, changed } = v;
  if (!fresh) {
    const lead = changed ? `Removed the hide for ${name}.` : `${name} had no hide set here.`;
    return { text: `${lead} ${UNVERIFIED}`, tone: "warn", needsRefresh: true };
  }
  if (fresh.active.some((d) => d.id === id)) {
    return {
      text: changed
        ? `Removed the hide for ${name}. They are back on the roster.`
        : `${name} had no hide set here and is on the roster.`,
      tone: "ok",
    };
  }
  if (fresh.hidden.some((d) => d.id === id)) {
    return {
      text: `${changed ? `Removed the hide for ${name}` : `${name} had no hide set here`}, but the refreshed roster still lists them under Hidden drivers. Review the list and try again.`,
      tone: "warn",
    };
  }
  if (fresh.patternMatchedIds?.includes(id)) {
    return {
      text: `${changed ? `Removed the hide set here for ${name}.` : `${name} had no hide set here.`} A name rule in Detection still excludes them from all weeks. Change that rule before they can return.`,
      tone: "warn",
    };
  }
  return {
    text: `${changed ? `Removed the hide for ${name}` : `${name} had no hide set here`}, but they are not shown in the refreshed roster. Check Detection rules and Samsara driver status.`,
    tone: "warn",
  };
}

/** Driver-pay managers only. Renders nothing (and loads nothing) for anyone else. */
export function DriverRosterPanel() {
  const { roles } = useAuth();
  if (!canManageDriverPay(roles)) return null;
  return <DriverRosterPanelInner />;
}

function DriverRosterPanelInner() {
  const q = useDriverRoster(true);
  const setVisibility = useSetDriverRosterVisibility();
  const focus = useActionFocus();
  const [filter, setFilter] = useState("");
  const [confirming, setConfirming] = useState<RosterDriver | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const afterHideRef = useRef<FocusTarget | null>(null);
  const verifyRef = useRef<Verify | null>(null);
  const refreshingRef = useRef(false);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const rosterHeadingRef = useRef<HTMLDivElement>(null);
  const hiddenHeadingRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const statusRefreshRef = useRef<HTMLButtonElement>(null);
  const busy = setVisibility.isPending;
  const thisWeek = hiddenFromFor(new Date());

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
    setFocusTarget(null);
    const fallbacks: Record<Fallback, HTMLElement | null> = {
      roster: rosterHeadingRef.current,
      hidden: hiddenHeadingRef.current,
      conflict: refreshRef.current,
      status: statusRefreshRef.current,
    };
    const byKey = focusTarget.key ? actionRefs.current.get(focusTarget.key) : undefined;
    const el =
      byKey?.isConnected && !byKey.disabled
        ? byKey
        : (fallbacks[focusTarget.fallback] ?? rosterHeadingRef.current);
    if (focusTarget.owner == null) el?.focus();
    else focus.restore(focusTarget.owner, el);
  }, [focusTarget, payload, focus]);

  const refFor = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) actionRefs.current.set(key, el);
    else actionRefs.current.delete(key);
  };

  /** A fresh roster from a successful read, or null when the read failed. */
  async function readFresh(): Promise<RosterPayload | null> {
    try {
      const r = (await q.refetch()) as { isError?: boolean; data?: unknown };
      return !r.isError && r.data ? (r.data as RosterPayload) : null;
    } catch {
      return null;
    }
  }

  async function change(driver: { id: string; name: string }, hide: boolean): Promise<FocusTarget> {
    setFailure(null);
    setRefreshError(null);
    setNotice(null);
    verifyRef.current = null;
    let result: { changed: boolean; hiddenFrom?: string | null };
    try {
      result = await setVisibility.mutateAsync({
        driverId: driver.id,
        hidden: hide,
        expectedUpdatedAt: payload?.settingsUpdatedAt ?? null,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Could not update the driver list.";
      setFailure(message);
      return message === ROSTER_CONFLICT_MESSAGE
        ? { key: "", fallback: "conflict" }
        : { key: `${hide ? "hide" : "restore"}:${driver.id}`, fallback: "roster" };
    }
    const fresh = await readFresh();
    if (hide) {
      const from = result.hiddenFrom ?? thisWeek;
      const lead = result.changed
        ? `Hid ${driver.name} from the week of ${weekLabel(from)} onward. Earlier weeks still include them, and their rates, events and history are kept.`
        : `${driver.name} was already hidden.`;
      if (!fresh) {
        setNotice({
          text: `${lead} Couldn't refresh the driver list. Refresh the list to check.`,
          tone: "warn",
          needsRefresh: true,
        });
        return { key: "", fallback: "status" };
      }
      setNotice({ text: lead, tone: "ok" });
      return { key: `restore:${driver.id}`, fallback: "hidden" };
    }
    const v = { id: driver.id, name: driver.name, changed: result.changed };
    const n = restoreNotice(v, fresh);
    setNotice(n);
    if (n.needsRefresh) {
      verifyRef.current = v;
      return { key: "", fallback: "status" };
    }
    return { key: `hide:${driver.id}`, fallback: "hidden" };
  }

  async function restore(driver: ExcludedDriver, trigger: HTMLElement) {
    const owner = focus.claim(trigger);
    const target = await change(driver, false);
    setFocusTarget({ ...target, owner });
  }

  /** Conflict "Refresh list" and the unverified-result "Refresh list". */
  async function refreshList(trigger: HTMLElement, from: "conflict" | "status") {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    const owner = focus.claim(trigger);
    const fresh = await readFresh();
    refreshingRef.current = false;
    setRefreshing(false);
    if (!fresh) {
      if (from === "conflict") {
        setRefreshError("Couldn't refresh the driver list. Try Refresh list again.");
      } else {
        setNotice((n) => ({
          text: `${n?.text ?? ""} Still couldn't refresh the driver list. Try Refresh list again.`.trim(),
          tone: "warn",
          needsRefresh: true,
        }));
      }
      setFocusTarget({ key: "", fallback: from, owner });
      return;
    }
    setFailure(null);
    const v = verifyRef.current;
    verifyRef.current = null;
    if (from === "status" && v) {
      setNotice(restoreNotice(v, fresh));
      setFocusTarget({ key: `hide:${v.id}`, fallback: "hidden", owner });
      return;
    }
    setNotice({
      text:
        from === "conflict"
          ? "Driver list refreshed. Review it and try again."
          : "Driver list refreshed.",
      tone: "ok",
    });
    setFocusTarget({ key: "", fallback: "roster", owner });
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
          <p className="text-xs text-muted-foreground" data-testid="driver-roster-intro">
            Drivers come from Samsara, saved warehouse events and pay rates. A new hide starts on
            Monday of the current Central Time week and excludes the driver from that week and later
            reports and estimated costs. It does not change earlier weeks. Older hides and name
            rules can exclude all weeks. Stored rates, events and history are kept. Restore removes
            the hide set here; a matching name rule must be changed separately in Detection.
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

      <div
        className={notice ? "flex items-start gap-2 rounded-md border p-3" : undefined}
        data-testid="driver-roster-result"
        data-tone={notice?.tone}
      >
        {notice &&
          (notice.tone === "ok" ? (
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ))}
        <div className="min-w-0 flex-1 space-y-2">
          <p
            role="status"
            aria-live="polite"
            className={notice ? "text-sm break-words" : "sr-only"}
            data-testid="driver-roster-live"
          >
            {notice?.text ?? ""}
          </p>
          {notice?.needsRefresh && (
            <Button
              ref={statusRefreshRef}
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={refreshing || undefined}
              data-testid="driver-roster-status-refresh"
              onClick={(e) => void refreshList(e.currentTarget, "status")}
            >
              {refreshing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Refresh list
            </Button>
          )}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-testid="driver-roster-progress">
        {refreshing ? "Refreshing the driver list…" : (refreshError ?? "")}
      </p>

      {failure && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive-text">{failure}</p>
          {isConflict && refreshError && (
            <p className="text-sm text-destructive-text" data-testid="driver-roster-refresh-error">
              {refreshError}
            </p>
          )}
          {isConflict && (
            <Button
              ref={refreshRef}
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={refreshing || undefined}
              onClick={(e) => void refreshList(e.currentTarget, "conflict")}
            >
              {refreshing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
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
      {q.isError && !notice?.needsRefresh && !isConflict && (
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
                  <div className="text-xs text-muted-foreground break-words">
                    <span className="break-all">Samsara id {d.id}</span>
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
                    <div className="text-xs text-muted-foreground break-words">
                      <span className="break-all">Samsara id {d.id}</span>
                    </div>
                    <div
                      className="text-xs text-muted-foreground break-words"
                      data-testid="driver-roster-hidden-label"
                    >
                      {d.alsoMatchesPattern
                        ? "Hidden in all weeks — matches a name rule in Detection. Restore removes the hide set here, but the name rule must also be changed before the driver can return."
                        : d.hiddenFrom
                          ? `Hidden from the week of ${weekLabel(d.hiddenFrom)} (Central Time).`
                          : "Hidden in all weeks — older hide."}
                    </div>
                    {d.alsoMatchesPattern && d.hiddenFrom && (
                      <div className="text-xs text-muted-foreground break-words">
                        Hide set here starts the week of {weekLabel(d.hiddenFrom)} (Central Time).
                      </div>
                    )}
                  </div>
                  <Button
                    ref={refFor(`restore:${d.id}`)}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={busy}
                    aria-label={`Restore ${d.name}`}
                    onClick={(e) => void restore(d, e.currentTarget)}
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
              They come off Driver rates and the weekly report from the week of{" "}
              {weekLabel(thisWeek)} onward. Earlier weeks keep their time and estimated cost. Their
              pay rates, warehouse events and capacity history are kept. You can restore them from
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
