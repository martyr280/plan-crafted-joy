/**
 * Parsers for the desktop Email Archiver (v4.5.x) state files, so the web app
 * starts with exactly the knowledge the desktop app has. Pure: text in, rows
 * out. The importer server function writes the rows; these functions never
 * touch the database. Re-runnable: every output row carries a natural key.
 *
 * Files (all next to config.json in the desktop install folder):
 *   customer-mapping.csv   CustomerKey,DisplayName,SenderDomains,Keywords,FolderPath
 *   learned-routing.json   { senders: {addr: entry}, domains: {dom: entry} }
 *   context-rules.json     { rules: [ {id, phrase, customer, scope, match, weight, hits, ...} ] }
 *   internal-routes.json   { routes: { addr: {customer, note, created, by} } }
 *   multi-routes.json      { rules: [ {id, kind, value, teams, scope, match, hits, ...} ] }
 *   mail-notes.json        { notes: { key: {needsReply, done, note, ...} } }
 *   config.json            settings (UTF-8 with BOM)
 *   .archiver/processed.log  one tab-separated line per filed email
 */
import type { ContextRule, LearnedEntry, LearnedStore, MappingRow, MultiRoute } from "./classify";

export function stripBom(text: string): string {
  return String(text ?? "").replace(/^﻿/, "");
}

export function parseJsonFile<T = any>(text: string): T {
  const t = stripBom(text).trim();
  if (!t) return {} as T;
  return JSON.parse(t) as T;
}

/** RFC-4180 CSV (quoted fields, "" escapes, CRLF or LF). */
export function parseCsv(text: string): Record<string, string>[] {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n") {
      row.push(f.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) {
    row.push(f.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const [h, ...rest] = rows;
  return rest
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => Object.fromEntries(h.map((k, i) => [k.trim(), r[i] ?? ""])));
}

export function parseMappingCsv(text: string): MappingRow[] {
  return parseCsv(text)
    .filter((r) => String(r.CustomerKey ?? "").trim())
    .map((r) => ({
      customerKey: String(r.CustomerKey).trim(),
      displayName: String(r.DisplayName ?? "").trim(),
      senderDomains: String(r.SenderDomains ?? "")
        .split(";")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      keywords: String(r.Keywords ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 1),
      folderPath: String(r.FolderPath ?? "").trim(),
    }));
}

export function parseLearned(text: string): LearnedStore {
  const j = parseJsonFile<any>(text);
  const out: LearnedStore = { senders: {}, domains: {} };
  for (const bucket of ["senders", "domains"] as const) {
    const src = j?.[bucket];
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries<any>(src)) {
      if (k === "__split") continue;
      const e: LearnedEntry = {
        customer: String(v?.customer ?? ""),
        count: Number.isFinite(Number(v?.count)) ? Math.trunc(Number(v.count)) : 0,
        source: String(v?.source ?? "") || "legacy",
        first: String(v?.first ?? ""),
        last: String(v?.last ?? ""),
        root: String(v?.root ?? ""),
        run: String(v?.run ?? ""),
      };
      out[bucket][k] = e;
    }
  }
  return out;
}

export function parseContextRules(text: string): Array<ContextRule & { hits: number; note: string; created: string }> {
  const j = parseJsonFile<any>(text);
  return (Array.isArray(j?.rules) ? j.rules : []).map((r: any) => {
    let w = Number(r?.weight);
    if (!(w > 0)) w = 0.94;
    if (w > 0.99) w = 0.99;
    if (w < 0.5) w = 0.5;
    return {
      id: String(r?.id ?? ""),
      phrase: String(r?.phrase ?? ""),
      customer: String(r?.customer ?? ""),
      scope: (String(r?.scope ?? "") || "any").toLowerCase() as ContextRule["scope"],
      match: (String(r?.match ?? "") || "contains").toLowerCase() as ContextRule["match"],
      weight: w,
      hits: Number.isFinite(Number(r?.hits)) ? Math.trunc(Number(r.hits)) : 0,
      note: String(r?.note ?? ""),
      created: String(r?.created ?? ""),
    };
  });
}

export function parseInternalRoutes(text: string): Array<{ address: string; customer: string; note: string; created: string; by: string }> {
  const j = parseJsonFile<any>(text);
  const routes = j?.routes && typeof j.routes === "object" ? j.routes : {};
  return Object.entries<any>(routes).map(([k, v]) => ({
    address: String(k).toLowerCase(),
    customer: String(v?.customer ?? ""),
    note: String(v?.note ?? ""),
    created: String(v?.created ?? ""),
    by: String(v?.by ?? ""),
  }));
}

export function parseMultiRoutes(text: string): Array<MultiRoute & { hits: number; note: string; created: string; by: string }> {
  const j = parseJsonFile<any>(text);
  return (Array.isArray(j?.rules) ? j.rules : [])
    .filter(Boolean)
    .map((r: any) => ({
      id: String(r?.id ?? ""),
      kind: String(r?.kind ?? "").trim().toLowerCase() as MultiRoute["kind"],
      value: String(r?.value ?? "").trim(),
      teams: (Array.isArray(r?.teams) ? r.teams : []).map((t: any) => String(t).trim()).filter(Boolean),
      scope: String(r?.scope ?? "") as MultiRoute["scope"],
      match: String(r?.match ?? "") as MultiRoute["match"],
      hits: Number.isFinite(Number(r?.hits)) ? Math.trunc(Number(r.hits)) : 0,
      note: String(r?.note ?? ""),
      created: String(r?.created ?? ""),
      by: String(r?.by ?? ""),
    }));
}

export interface MailNote {
  key: string;
  needsReply: boolean;
  done: boolean;
  note: string;
  received: string;
  subject: string;
  sender: string;
  customer: string;
  created: string;
  updated: string;
  by: string;
  doneAt: string;
}

function boolSafe(v: unknown, d = false): boolean {
  if (v === null || v === undefined) return d;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off", ""].includes(s)) return false;
  return d;
}

export function parseMailNotes(text: string): MailNote[] {
  const j = parseJsonFile<any>(text);
  const notes = j?.notes && typeof j.notes === "object" ? j.notes : {};
  return Object.entries<any>(notes).map(([k, v]) => ({
    key: k,
    needsReply: boolSafe(v?.needsReply),
    done: boolSafe(v?.done),
    note: String(v?.note ?? ""),
    received: String(v?.received ?? ""),
    subject: String(v?.subject ?? ""),
    sender: String(v?.sender ?? ""),
    customer: String(v?.customer ?? ""),
    created: String(v?.created ?? ""),
    updated: String(v?.updated ?? ""),
    by: String(v?.by ?? ""),
    doneAt: String(v?.doneAt ?? ""),
  }));
}

/**
 * processed.log lines (tab-separated, '#' = header comment):
 *   at, key, entryId, stem, destination, host, user
 * key is "mid:<message-id lower-case>" or "eid:<EntryID>". Lines with fewer
 * than 3 fields are skipped, as Read-ProcessedLedger does.
 */
export function parseLedger(
  text: string,
): Array<{ at: string; key: string; entryId: string; stem: string; destination: string; host: string; user: string }> {
  return stripBom(text)
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 3)
    .map(([at = "", key = "", entryId = "", stem = "", destination = "", host = "", user = ""]) => ({
      at, key, entryId, stem, destination, host, user,
    }))
    .filter((r) => r.key.startsWith("mid:") || r.key.startsWith("eid:"));
}

/** Ledger key for a message, identical to Get-LedgerKey on the desktop. */
export function ledgerKey(internetMessageId: string, entryId = ""): string {
  const m = String(internetMessageId ?? "").trim();
  if (m) return "mid:" + m.toLowerCase();
  return "eid:" + String(entryId ?? "").trim();
}

/** Settings carried over from config.json into app_settings['archiver']. */
export const IMPORTED_SETTING_KEYS = [
  "confidence_threshold", "unrouted_folder", "ignored_folder", "ignored_domains", "excluded_domains",
  "excluded_senders", "never_context_domains", "multi_territory_domains", "content_only_senders",
  "ignore_subject_patterns", "filename_stamp", "filename_max_chars", "skip_internal_replies",
  "learning_enabled", "learn_promote_after", "learn_min_confidence", "context_margin",
  "external_context_floor", "body_chars", "processed_category", "watched_folder",
] as const;

export function pickImportedSettings(configText: string): Record<string, unknown> {
  const cfg = parseJsonFile<Record<string, unknown>>(configText);
  const out: Record<string, unknown> = {};
  for (const k of IMPORTED_SETTING_KEYS) if (k in cfg) out[k] = cfg[k];
  return out;
}
