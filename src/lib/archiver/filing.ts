/**
 * Order Mail filing — pure planning and reconciliation. No I/O here; the
 * server module (filing.server.ts) loads rows, calls these, and writes results.
 *
 * Lifecycle of one email in LIVE mode:
 *   classified -> planFilings() -> one file.save job per team (primary + copies)
 *   agent writes the files   -> reconcileFiling() per job result
 *   all filings done         -> message 'filed', ledger row, Outlook marker, learning
 * Human actions (Wrong team?, Archive, Also file to, Restore) -> planAction() -> file.move jobs.
 */
import { setLearnedEntry, updateLearnedFromResults, type LearnedStore } from "./classify";

export const FILE_JOB_KINDS = ["file.save", "file.move", "archive.probe", "archive.ledger.read"] as const;

export interface TeamRow { key: string; folder_path: string; kind: string }
export interface FilingPlan {
  team_key: string;
  kind: "primary" | "copy" | "refile" | "archive" | "restore";
  rel_path: string; // destination folder relative to ARCHIVE_ROOT
  file_name: string; // intended name (agent may add " (2)")
  idempotency_key: string;
}

export function storagePathFor(messageId: string, receivedAtIso: string): string {
  const d = new Date(receivedAtIso);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}/${m}/${messageId}.eml`;
}

/** Primary filing + one copy per extra team. SKIPPED files nothing. */
export function planFilings(
  messageId: string,
  decision: { customerKey: string; alsoCustomers: string[]; stem: string },
  teams: Map<string, TeamRow>,
): FilingPlan[] {
  if (decision.customerKey === "SKIPPED") return [];
  const out: FilingPlan[] = [];
  const add = (key: string, kind: FilingPlan["kind"]) => {
    const t = teams.get(key);
    if (!t) throw new Error(`no folder configured for team ${key}`);
    out.push({ team_key: t.key, kind, rel_path: t.folder_path, file_name: `${decision.stem}.eml`,
      idempotency_key: `file:${messageId}:${t.key}:${kind}` });
  };
  add(decision.customerKey, "primary");
  for (const k of decision.alsoCustomers ?? []) if (k !== decision.customerKey) add(k, "copy");
  return out;
}

export type HumanAction =
  | { action: "wrong_team"; toTeam: string }
  | { action: "archive" }
  | { action: "restore" }
  | { action: "also_file"; teams: string[] };

export interface FiledFile { filing_id: string; team_key: string; kind: string; written_path: string | null; status: string }

/**
 * Turn a human action into file.move jobs. `files` = the email's current done filings.
 * Wrong team? moves the primary file; Archive moves every copy to Ignored (desktop
 * Invoke-MailArchive); Restore moves the primary back to its team; Also file to copies.
 */
export function planAction(
  messageId: string,
  act: HumanAction,
  files: FiledFile[],
  teams: Map<string, TeamRow>,
  stamp: string, // makes the idempotency key unique per click
): Array<{ fromRelPath: string; toRelDir: string; mode: "move" | "copy"; team_key: string; kind: FilingPlan["kind"]; idempotency_key: string; supersedes: string }> {
  const live = files.filter((f) => f.status === "done" && f.written_path);
  const primary = live.find((f) => f.kind === "primary" || f.kind === "refile" || f.kind === "restore");
  const folder = (k: string) => {
    const t = teams.get(k);
    if (!t) throw new Error(`no folder configured for team ${k}`);
    return t.folder_path;
  };
  const ignoredKey = [...teams.values()].find((t) => t.kind === "ignored")?.key ?? "IGNORED";
  switch (act.action) {
    case "wrong_team": {
      if (!primary) throw new Error("this email has no filed copy to move yet");
      if (primary.team_key === act.toTeam) return [];
      return [{ fromRelPath: primary.written_path!, toRelDir: folder(act.toTeam), mode: "move", team_key: act.toTeam, kind: "refile",
        idempotency_key: `move:${messageId}:${act.toTeam}:refile:${stamp}`, supersedes: primary.filing_id }];
    }
    case "archive":
      return live.filter((f) => f.kind !== "archive").map((f) => ({ fromRelPath: f.written_path!, toRelDir: folder(ignoredKey), mode: "move" as const,
        team_key: ignoredKey, kind: "archive" as const, idempotency_key: `move:${messageId}:${f.filing_id}:archive:${stamp}`, supersedes: f.filing_id }));
    case "restore": {
      const archived = live.filter((f) => f.kind === "archive");
      if (!archived.length) throw new Error("this email is not archived");
      return []; // caller supplies the team: see planRestore
    }
    case "also_file": {
      if (!primary) throw new Error("this email has no filed copy to copy yet");
      const have = new Set(live.map((f) => f.team_key));
      return act.teams.filter((k) => !have.has(k)).map((k) => ({ fromRelPath: primary.written_path!, toRelDir: folder(k), mode: "copy" as const,
        team_key: k, kind: "copy" as const, idempotency_key: `copy:${messageId}:${k}:${stamp}`, supersedes: "" }));
    }
  }
}

/** Restore: move the archived primary back to the team the email was routed to (desktop restores the primary set only). */
export function planRestore(messageId: string, files: FiledFile[], toTeam: string, teams: Map<string, TeamRow>, stamp: string) {
  const archived = files.filter((f) => f.status === "done" && f.kind === "archive" && f.written_path);
  if (!archived.length) throw new Error("this email is not archived");
  const t = teams.get(toTeam);
  if (!t) throw new Error(`no folder configured for team ${toTeam}`);
  const first = archived[0];
  return [{ fromRelPath: first.written_path!, toRelDir: t.folder_path, mode: "move" as const, team_key: toTeam, kind: "restore" as const,
    idempotency_key: `move:${messageId}:${toTeam}:restore:${stamp}`, supersedes: first.filing_id }];
}

/** Message status after its filings change. */
export function messageStatusFromFilings(filings: Array<{ kind: string; status: string }>): "queued" | "filed" | "failed" | "archived" {
  const active = filings.filter((f) => f.status !== "superseded");
  if (active.some((f) => f.status === "error")) return "failed";
  if (active.some((f) => f.status === "queued")) return "queued";
  if (active.length && active.every((f) => f.kind === "archive")) return "archived";
  return "filed";
}

/** Ledger line the web app writes when an email is filed (same shape as the desktop processed.log). */
export function ledgerDestination(primaryFolder: string, copyFolders: string[]): string {
  return copyFolders.length ? `${primaryFolder} (+ copies: ${copyFolders.join("; ")})` : primaryFolder;
}

/**
 * Learning after a filing is confirmed (live mode). Returns the learned rows that
 * changed, for upsert. Same rules as the desktop: confident, non-context,
 * not content-only, not IGNORED/UNROUTED.
 */
export function learnFromFiling(
  learned: LearnedStore,
  filed: { senderAddress: string; customerKey: string; confidence: number; matchSource: string },
  opts: { ignoredDomains: string[]; neverLearn: string[]; multiTerritory: string[]; contentOnly: string[]; now: string; runId: string },
) {
  const before = JSON.stringify(learned);
  const n = updateLearnedFromResults(learned, [{ ...filed, filed: true }], { ...opts, minConf: 0.9, root: "web" });
  return { taught: n, changed: before !== JSON.stringify(learned) };
}

/** Wrong team? / Teach: a human correction. Content-only senders move the email only. */
export function learnFromHuman(
  learned: LearnedStore,
  senderAddress: string,
  toTeam: string,
  source: "corrected" | "taught",
  opts: { contentOnly: string[]; ignoredDomains: string[]; multiTerritory: string[]; freeMail: (d: string) => boolean; now: string },
): Array<{ bucket: "sender" | "domain"; key: string }> {
  const addr = String(senderAddress ?? "").trim().toLowerCase();
  if (!addr || !addr.includes("@")) return [];
  if (opts.contentOnly.map((x) => x.toLowerCase()).includes(addr)) return [];
  const dom = addr.split("@").pop()!;
  const ignored = opts.ignoredDomains.some((d) => dom === d || dom.endsWith("." + d));
  if (ignored) return [];
  const touched: Array<{ bucket: "sender" | "domain"; key: string }> = [];
  setLearnedEntry(learned, "senders", addr, toTeam, source, opts.now, "web", "");
  touched.push({ bucket: "sender", key: addr });
  const multi = opts.multiTerritory.some((d) => dom === d || dom.endsWith("." + d));
  if (!multi && !opts.freeMail(dom)) {
    setLearnedEntry(learned, "domains", dom, toTeam, source, opts.now, "web", "");
    touched.push({ bucket: "domain", key: dom });
  }
  return touched;
}
