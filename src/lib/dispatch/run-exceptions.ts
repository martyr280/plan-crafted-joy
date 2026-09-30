// Run exceptions applied to Samsara run building and pushing. Pure, no I/O.
//
//  * no_run: the builder never builds that (route, date); tickets roll to the
//    next open run via assignRun (the same function the Tickets-by-cutoff
//    board uses). An existing draft is kept but shown "Run cancelled
//    (exception)" and can never be pushed.
//  * reduced: builds as normal; the run carries a "Reduced — <reason>" flag.

import { assignRun, nextOpenRunDate, type AssignCutoff, type ExceptionReason, type NoRunException } from "./assign";

export type RunException = {
  p21_code: string;
  run_date: string;
  kind: "no_run" | "reduced";
  reason: ExceptionReason;
  note?: string | null;
};

export const REASON_LABEL: Record<ExceptionReason, string> = {
  short_week: "Short week",
  driver_pto: "Driver PTO",
  other: "Other",
};

export function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

export function exceptionFor(list: RunException[], p21Code: string, runDate: string): RunException | null {
  const code = String(p21Code ?? "").toUpperCase();
  return list.find((e) => String(e.p21_code).toUpperCase() === code && String(e.run_date).slice(0, 10) === runDate) ?? null;
}

export function noRunsFor(list: RunException[], p21Code: string): NoRunException[] {
  const code = String(p21Code ?? "").toUpperCase();
  return list
    .filter((e) => e.kind === "no_run" && String(e.p21_code).toUpperCase() === code)
    .map((e) => ({ run_date: String(e.run_date).slice(0, 10), reason: e.reason }));
}

export function noRunMessage(exc: RunException, nextRunDate: string | null): string {
  const why = REASON_LABEL[exc.reason] + (exc.note ? ` (${exc.note})` : "");
  const roll = nextRunDate ? `Tickets roll to ${prettyDate(nextRunDate)}.` : "No open run found in the next 60 days.";
  return `No run on ${prettyDate(String(exc.run_date).slice(0, 10))} — ${why}. ${roll}`;
}

export function reducedLabel(exc: RunException): string {
  return `Reduced — ${REASON_LABEL[exc.reason]}${exc.note ? `: ${exc.note}` : ""}`;
}

export type RunFlag =
  | { kind: "no_run"; badge: "Run cancelled (exception)"; message: string }
  | { kind: "reduced"; badge: string; message: string }
  | null;

/** Badge + message for a run row (drafts, detail and approve dialog). */
export function runFlag(list: RunException[], p21Code: string, runDate: string, cutoffs: AssignCutoff[]): RunFlag {
  const exc = exceptionFor(list, p21Code, runDate);
  if (!exc) return null;
  if (exc.kind === "no_run") {
    const next = nextOpenRunDate(runDate, cutoffs, noRunsFor(list, p21Code));
    return { kind: "no_run", badge: "Run cancelled (exception)", message: noRunMessage(exc, next) };
  }
  return { kind: "reduced", badge: reducedLabel(exc), message: reducedLabel(exc) };
}

/** Push/approve guard: a message when blocked, else null. */
export function pushBlockedReason(list: RunException[], p21Code: string, runDate: string, cutoffs: AssignCutoff[]): string | null {
  const f = runFlag(list, p21Code, runDate, cutoffs);
  return f?.kind === "no_run" ? f.message : null;
}

export type PlannedBuild<R> = {
  /** Run dates to build, with the tickets assigned to each. */
  build: Array<{ runDate: string; rows: R[]; reduced: string | null }>;
  /** Run dates skipped because of a no_run exception. */
  skipped: Array<{ runDate: string; message: string }>;
};

/**
 * Plan which of a cutoff's run dates to build and which tickets go on each.
 * Ticket → run date is assignRun(date, cutoffs, today, noRuns): the same call
 * the Tickets-by-cutoff board makes, so a ticket rolled past a no_run lands in
 * the next run's build.
 */
export function planRunBuild<R extends Record<string, unknown>>(input: {
  rows: R[];
  dateColumn: string;
  cutoffs: AssignCutoff[];
  p21Code: string;
  runDates: string[];
  today: string;
  exceptions: RunException[];
}): PlannedBuild<R> {
  const noRuns = noRunsFor(input.exceptions, input.p21Code);
  const out: PlannedBuild<R> = { build: [], skipped: [] };
  const byDate = new Map<string, R[]>();
  for (const r of input.rows) {
    const a = assignRun(r[input.dateColumn], input.cutoffs, input.today, noRuns);
    if (a.status !== "assigned") continue;
    const list = byDate.get(a.runDate) ?? [];
    list.push(r);
    byDate.set(a.runDate, list);
  }
  for (const d of input.runDates) {
    const exc = exceptionFor(input.exceptions, input.p21Code, d);
    if (exc?.kind === "no_run") {
      out.skipped.push({ runDate: d, message: noRunMessage(exc, nextOpenRunDate(d, input.cutoffs, noRuns)) });
      continue;
    }
    out.build.push({ runDate: d, rows: byDate.get(d) ?? [], reduced: exc?.kind === "reduced" ? reducedLabel(exc) : null });
  }
  return out;
}
