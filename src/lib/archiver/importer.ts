/**
 * Desktop -> web import plan (pure). Turns the desktop Email Archiver's state
 * files into the rows the Order Mail tables hold. The server writer
 * (importer.server.ts) upserts them; re-running with the same files changes
 * nothing. Used twice: now (shadow mode, from a copy) and on cutover day (from
 * the live O: folder, after the desktop service is stopped).
 */
import {
  ledgerKey, parseContextRules, parseInternalRoutes, parseLearned, parseLedger, parseMailNotes, parseMappingCsv,
  parseMultiRoutes, pickImportedSettings,
} from "./import-desktop";

export interface DesktopFiles {
  mappingCsv?: string; // customer-mapping.csv
  learnedJson?: string; // learned-routing.json
  contextRulesJson?: string; // context-rules.json
  internalRoutesJson?: string; // internal-routes.json
  multiRoutesJson?: string; // multi-routes.json
  mailNotesJson?: string; // mail-notes.json
  ledgerLog?: string; // .archiver/processed.log
  configJson?: string; // config.json
}

export interface ImportOptions {
  /** Entries removed on the desktop after the copy was taken (e.g. the 7 Oct cleanup). */
  removeLearned?: Array<{ bucket: "sender" | "domain"; key: string }>;
  /** Settings to force after import (e.g. v4.5.2 values not yet in the copied config). */
  settingsOverride?: Record<string, unknown>;
}

const LEARN_SOURCES = new Set(["auto", "taught", "corrected", "archive", "legacy", "import"]);

export function noteKeyToLedgerKey(k: string): string {
  const s = String(k ?? "").trim();
  if (s.startsWith("mid:") || s.startsWith("eid:")) return s;
  if (s.startsWith("<") || s.includes("@")) return ledgerKey(s);
  return s; // received|subject fallback key — kept verbatim
}

export function buildImportPlan(f: DesktopFiles, opts: ImportOptions = {}) {
  const teams = f.mappingCsv
    ? parseMappingCsv(f.mappingCsv).map((m, i) => ({
        key: m.customerKey, display_name: m.displayName, folder_path: m.folderPath, kind: "team" as const,
        sender_domains: m.senderDomains, keywords: m.keywords, sort_order: i + 1,
      }))
    : [];
  const teamKeys = new Set([...teams.map((t) => t.key), "IGNORED", "UNROUTED"]);

  const contentRules = f.contextRulesJson
    ? parseContextRules(f.contextRulesJson).map((r) => ({
        id: r.id, phrase: r.phrase, team_key: r.customer, scope: r.scope, match: r.match, weight: r.weight,
        note: r.note, hits: r.hits, source: "desktop_import" as const, created_local: r.created, created_by_name: "desktop",
      }))
    : [];

  const internalRoutes = f.internalRoutesJson
    ? parseInternalRoutes(f.internalRoutesJson).map((r) => ({
        address: r.address, team_key: r.customer, note: r.note, source: "desktop_import" as const,
        created_local: r.created, created_by_name: r.by,
      }))
    : [];

  const multiRoutes = f.multiRoutesJson
    ? parseMultiRoutes(f.multiRoutesJson)
        .filter((r) => r.teams.length >= 2)
        .map((r) => ({
          id: r.id, kind: r.kind, value: r.value, team_keys: r.teams, scope: r.scope ?? "", match: r.match ?? "",
          note: r.note, hits: r.hits, source: "desktop_import" as const, created_local: r.created, created_by_name: r.by,
        }))
    : [];

  const removed = new Set((opts.removeLearned ?? []).map((r) => `${r.bucket}|${r.key.toLowerCase()}`));
  const learned: Array<{ bucket: "sender" | "domain"; key: string; team_key: string; count: number; source: string;
    first_at: string; last_at: string; root: string; run: string }> = [];
  if (f.learnedJson) {
    const l = parseLearned(f.learnedJson);
    for (const [bucket, store] of [["sender", l.senders], ["domain", l.domains]] as const) {
      for (const [k, e] of Object.entries(store)) {
        const key = k.toLowerCase();
        if (removed.has(`${bucket}|${key}`)) continue;
        learned.push({ bucket, key, team_key: e.customer, count: e.count, source: LEARN_SOURCES.has(e.source) ? e.source : "legacy",
          first_at: e.first ?? "", last_at: e.last ?? "", root: e.root ?? "", run: e.run ?? "" });
      }
    }
  }

  const notes = f.mailNotesJson
    ? parseMailNotes(f.mailNotesJson).map((n) => ({
        ledger_key: noteKeyToLedgerKey(n.key), needs_reply: n.needsReply, done: n.done, note: n.note, subject: n.subject,
        sender: n.sender, team_key: n.customer, received: n.received, by_name: n.by, done_at_local: n.doneAt,
      }))
    : [];

  const ledger = f.ledgerLog
    ? parseLedger(f.ledgerLog).map((r) => ({
        key: r.key, entry_id: r.entryId, stem: r.stem, destination: r.destination, filed_at: r.at, host: r.host,
        user_name: r.user, source: "desktop" as const,
      }))
    : [];
  // Last line wins for a repeated key (re-filed emails).
  const ledgerByKey = new Map(ledger.map((r) => [r.key, r]));

  const settings = { ...(f.configJson ? pickImportedSettings(f.configJson) : {}), ...(opts.settingsOverride ?? {}) };

  const unknownTeamRules = [
    ...contentRules.filter((r) => !teamKeys.has(r.team_key)).map((r) => `content rule ${r.id} -> ${r.team_key}`),
    ...internalRoutes.filter((r) => !teamKeys.has(r.team_key)).map((r) => `internal route ${r.address} -> ${r.team_key}`),
    ...multiRoutes.flatMap((r) => r.team_keys.filter((t) => !teamKeys.has(t)).map((t) => `multi route ${r.id} -> ${t}`)),
  ];

  return {
    teams, contentRules, internalRoutes, multiRoutes, learned, notes, ledger: Array.from(ledgerByKey.values()), settings,
    warnings: unknownTeamRules.length && teams.length ? unknownTeamRules : [],
    counts: {
      teams: teams.length, content_rules: contentRules.length, internal_routes: internalRoutes.length,
      multi_routes: multiRoutes.length, learned_senders: learned.filter((x) => x.bucket === "sender").length,
      learned_domains: learned.filter((x) => x.bucket === "domain").length, learned_removed: removed.size,
      notes: notes.length, ledger: ledgerByKey.size, settings: Object.keys(settings).length,
    },
  };
}

export type ImportPlan = ReturnType<typeof buildImportPlan>;

/**
 * Rows people changed in the web app win over a later desktop import:
 * - content rules / internal routes / multi routes that already exist with source='web' are left alone
 *   (matched on the same natural key the importer upserts on: id, address, kind+value);
 * - learned rows marked 'forgotten' stay forgotten (otherwise a re-import would bring back
 *   exactly the bad entries that were removed, e.g. ndiof.com on 7 Oct 2026).
 */
export interface ProtectedKeys {
  contentRuleIds: Iterable<string>;
  internalRouteAddresses: Iterable<string>;
  multiRouteKeys: Iterable<string>; // `${kind}|${value}` lower-case
  forgottenLearned: Iterable<string>; // `${bucket}|${key}` lower-case
}
export function withoutProtected(plan: ImportPlan, p: ProtectedKeys): { plan: ImportPlan; skipped: Record<string, number> } {
  const ids = new Set(Array.from(p.contentRuleIds, String));
  const addrs = new Set(Array.from(p.internalRouteAddresses, (a) => String(a).toLowerCase()));
  const multi = new Set(Array.from(p.multiRouteKeys, (k) => String(k).toLowerCase()));
  const forgotten = new Set(Array.from(p.forgottenLearned, (k) => String(k).toLowerCase()));
  const contentRules = plan.contentRules.filter((r) => !ids.has(String(r.id)));
  const internalRoutes = plan.internalRoutes.filter((r) => !addrs.has(String(r.address).toLowerCase()));
  const multiRoutes = plan.multiRoutes.filter((r) => !multi.has(`${r.kind}|${r.value}`.toLowerCase()));
  const learned = plan.learned.filter((r) => !forgotten.has(`${r.bucket}|${r.key}`.toLowerCase()));
  return {
    plan: { ...plan, contentRules, internalRoutes, multiRoutes, learned },
    skipped: {
      content_rules: plan.contentRules.length - contentRules.length, internal_routes: plan.internalRoutes.length - internalRoutes.length,
      multi_routes: plan.multiRoutes.length - multiRoutes.length, learned: plan.learned.length - learned.length,
    },
  };
}
