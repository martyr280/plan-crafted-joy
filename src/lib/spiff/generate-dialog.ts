// Pure, browser-safe helpers for the SPIFF Generate confirmation dialog.

export type DialogRun = { id: string; quarter_label: string; status: string; created_at: string };
export type DialogLine = {
  included: boolean;
  exclusion_reason?: string | null;
  rep_parse_confidence?: string | null;
  flags?: Record<string, unknown> | null;
};

export type GenerateDialog = {
  mode: "draft" | "new_run" | "none";
  title: string;
  body: string;
  warning: string | null;
  action: string;
};

/** Latest run for the quarter by created_at — same rule as the server's draft lookup. */
export function latestRunForQuarter<R extends DialogRun>(runs: R[], quarterLabel: string): R | null {
  let best: R | null = null;
  for (const r of runs) {
    if (r.quarter_label !== quarterLabel) continue;
    if (!best || r.created_at > best.created_at) best = r;
  }
  return best;
}

export function manualEditCounts(lines: DialogLine[]) {
  let exclusions = 0, reIncludes = 0, reps = 0;
  for (const l of lines) {
    if (!l.included && l.exclusion_reason === "manual") exclusions++;
    if (l.included && l.flags?.manual_include === true) reIncludes++;
    if (l.rep_parse_confidence === "manual") reps++;
  }
  return { exclusions, reIncludes, reps };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07-01" + exclusive "2026-10-01" → "Jul 1 – Sep 30, 2026". */
export function inclusiveRangeLabel(from: string, toExclusive: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(Date.parse(`${toExclusive}T00:00:00Z`) - 86_400_000);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return `${from} – ${toExclusive}`;
  const md = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return f.getUTCFullYear() === t.getUTCFullYear()
    ? `${md(f)} – ${md(t)}, ${t.getUTCFullYear()}`
    : `${md(f)}, ${f.getUTCFullYear()} – ${md(t)}, ${t.getUTCFullYear()}`;
}

export function generateDialogCopy(args: {
  runs: DialogRun[];
  quarterLabel: string;
  currentRunId: string | null;
  lines: DialogLine[];
  rangeLabel: string;
}): GenerateDialog {
  const { quarterLabel: q, rangeLabel } = args;
  const latest = latestRunForQuarter(args.runs, q);
  if (!latest) {
    return {
      mode: "none",
      title: `Generate ${q}?`,
      body: `This pulls ${q} (${rangeLabel}) from P21 and creates a new SPIFF run.`,
      warning: null,
      action: "Generate",
    };
  }
  if (latest.status === "draft") {
    let edits = "Manual exclusions, manual re-includes and rep reassignments";
    if (args.currentRunId === latest.id) {
      const c = manualEditCounts(args.lines);
      edits = `${c.exclusions} manual exclusions, ${c.reIncludes} manual re-includes and ${c.reps} rep reassignments`;
    }
    return {
      mode: "draft",
      title: `Regenerate ${q} draft?`,
      body: `Lines for ${q} (${rangeLabel}) are re-pulled from P21. ${edits} on the current draft will be carried over to matching lines; any that no longer match are listed after the run.`,
      warning: null,
      action: "Regenerate",
    };
  }
  return {
    mode: "new_run",
    title: `Create a new ${q} run?`,
    body: `The ${latest.status} run is kept unchanged; a new draft run is created from P21 (${rangeLabel}).`,
    warning: latest.status === "in_review"
      ? `The current ${q} run is in review — reps may already have its sheets. The new draft will not be sent automatically.`
      : null,
    action: "Create new run",
  };
}

/** Re-entry guard: run(fn) returns null without calling fn while a previous call is in flight. */
export function createInFlightGuard() {
  const ref = { current: false };
  return {
    ref,
    async run<T>(fn: () => Promise<T>): Promise<T | null> {
      if (ref.current) return null;
      ref.current = true;
      try {
        return await fn();
      } finally {
        ref.current = false;
      }
    },
  };
}
