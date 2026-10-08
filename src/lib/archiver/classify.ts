/**
 * Order Mail classifier — a line-for-line port of Email Archiver v4.5.2
 * (archiver-lib.ps1: Classify-Candidate, Get-BodyOriginators,
 * Resolve-AddressToCustomer, Get-SplitDomains, context votes, Find-MultiRoute,
 * New-FileStem). Pure: no I/O, no clock, no randomness.
 *
 * WHY a literal port: the desktop engine is what NDI's teams trust today. The
 * web app must make the same decision on the same input before anything new
 * is layered on. Parity is proven by scripts/archiver-parity (differential run
 * against the PowerShell engine). Change behaviour here only with a parity
 * re-run and a note in docs/archiver-parity.md.
 *
 * PowerShell semantics preserved deliberately:
 *  - hashtable lookups are case-insensitive (customer keys, learned keys);
 *  - Math.Round is banker's rounding (round half to even);
 *  - string -eq is case-insensitive; .Contains() is ordinal.
 */

export type MatchMode = "contains" | "word" | "regex";
export type Scope = "any" | "subject" | "body" | "attachments";

export interface Candidate {
  /** Stable id of the message (Graph immutable id; EntryID on desktop). */
  id: string;
  messageId?: string;
  senderAddress: string;
  senderName?: string;
  subject: string;
  /** Local (America/Chicago) wall-clock time, "yyyy-MM-ddTHH:mm:ss". */
  receivedAt: string;
  /** Plain-text body, already truncated to body_chars (4000). */
  body: string;
  attachmentNames: string[];
}

export interface MappingRow {
  customerKey: string;
  displayName: string;
  senderDomains: string[]; // lower-case, trimmed
  keywords: string[]; // lower-case, length > 1
  folderPath: string;
}

export interface LearnedEntry {
  customer: string;
  count: number;
  source: string; // archive | auto | taught | corrected | legacy | import
  first?: string;
  last?: string;
  root?: string;
  run?: string;
}

export interface LearnedStore {
  senders: Record<string, LearnedEntry>;
  domains: Record<string, LearnedEntry>;
}

export interface ContextRule {
  id: string;
  phrase: string;
  customer: string;
  scope: Scope;
  match: MatchMode;
  weight: number;
}

export interface MultiRoute {
  id: string;
  kind: "sender" | "domain" | "phrase";
  value: string;
  teams: string[];
  scope?: Scope | "";
  match?: MatchMode | "";
}

export interface ClassifyConfig {
  threshold: number; // confidence_threshold, 0.7 in production
  unroutedFolder: string; // "Unrouted"
  ignoredDomains: string[]; // ignored_domains (blank in production)
  neverContext: string[]; // built-in list + never_context_domains
  margin: number; // context_margin, 1.35
  externalContextFloor: number; // external_context_floor, 0.85
  multiTerritory: string[]; // multi_territory_domains
  stampMode: "suffix" | "prefix" | "none";
  stemMax: number; // filename_max_chars, 40..200
  skipInternalReplies: boolean;
  contentOnly: string[]; // content_only_senders
  autoIgnore: { patterns: string[]; folder: string } | null;
}

export interface Knowledge {
  mapping: MappingRow[];
  learned: LearnedStore | null;
  ctxRules: ContextRule[];
  /** internal routes: lower-case address -> customer key */
  internalRoutes: Record<string, string>;
  multiRoutes: MultiRoute[];
}

export interface Decision {
  id: string;
  customerKey: string; // team key | UNROUTED | IGNORED | SKIPPED
  confidence: number;
  destinationRelPath: string;
  stem: string;
  matchSource: string;
  evidence: string;
  ambiguity: string;
  ruleId: string;
  alsoCustomers: string[];
  alsoDestinations: string[];
}

export const FREE_MAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net",
  "sbcglobal.net", "verizon.net", "proton.me", "protonmail.com", "pm.me", "gmx.com", "zoho.com",
];

export const NEVER_CONTEXT_BUILT_IN = [
  "notification.intuit.com", "intuit.com", "quickbooks.com", "globalindustrial.com", "wetransfer.com",
  "echo.com", "fedex.com", "fedexfreight.com", "ups.com", "arcb.com", "rlcarriers.com", "sefl.com",
  "landstarmail.com", "aaacooper.com", "brighterlogistics.com", "ess.barracudanetworks.com",
  "docusign.net", "docusign.com", "sendgrid.net", "onmicrosoft.com",
];

// ---------------------------------------------------------------- helpers

/** .NET Math.Round(x, digits) — round half to even. */
export function roundHalfEven(x: number, digits: number): number {
  const f = Math.pow(10, digits);
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let r: number;
  if (diff > 0.5 + eps) r = floor + 1;
  else if (diff < 0.5 - eps) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return r / f;
}

export function splitList(v: unknown): string[] {
  return String(v ?? "")
    .split(";")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function testDomainInList(d: string, list: string[]): boolean {
  const dom = String(d ?? "").toLowerCase();
  if (!dom) return false;
  for (const i of list) if (dom === i || dom.endsWith("." + i)) return true;
  return false;
}

export function isFreeMailDomain(d: string): boolean {
  return FREE_MAIL_DOMAINS.includes(String(d ?? "").toLowerCase());
}

function domainOf(addr: string): string {
  return addr.includes("@") ? addr.split("@").pop()! : "";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/#\-\s]/g, (m) => (/\s/.test(m) ? m : "\\" + m));
}

/** Compile a .NET-style pattern for JS. Leading inline (?i) / (?im) flags become JS flags. */
export function compileDotNetRegex(pattern: string, ignoreCase: boolean, global = false): RegExp | null {
  let p = pattern;
  let flags = ignoreCase ? "i" : "";
  const inline = /^\(\?([imsx]+)\)/.exec(p);
  if (inline) {
    p = p.slice(inline[0].length);
    for (const c of inline[1]) if ((c === "i" || c === "m" || c === "s") && !flags.includes(c)) flags += c;
  }
  if (global) flags += "g";
  try {
    return new RegExp(p, flags);
  } catch {
    return null;
  }
}

function sanitizeStem(s: string): string {
  return String(s ?? "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function newFileStem(c: Pick<Candidate, "subject" | "receivedAt">, stampMode: string, maxChars: number): string {
  const ts = String(c.receivedAt ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) throw new Error(`receivedAt must be yyyy-MM-ddTHH:mm:ss, got '${ts}'`);
  const stamp = `${m[1]}${m[2]}${m[3]}_${m[4]}${m[5]}${m[6]}`;
  let subj = sanitizeStem(c.subject);
  if (!subj) subj = "no subject";
  let max = maxChars;
  if (max < 40) max = 40;
  const mode = String(stampMode ?? "").toLowerCase();
  const room = max - (mode === "none" ? 0 : stamp.length + 1);
  if (subj.length > room) subj = subj.substring(0, room).trimEnd();
  if (mode === "prefix") return `${stamp}_${subj}`;
  if (mode === "none") return subj;
  return `${subj}_${stamp}`;
}

// --------------------------------------------------------- content rules

function ruleHaystack(c: Candidate, scope: string): string {
  switch (scope) {
    case "subject":
      return String(c.subject ?? "").toLowerCase();
    case "body":
      return String(c.body ?? "").toLowerCase();
    case "attachments":
      return (c.attachmentNames ?? []).join(" ").toLowerCase();
    default:
      return `${c.subject ?? ""} ${c.body ?? ""} ${(c.attachmentNames ?? []).join(" ")}`.toLowerCase();
  }
}

export function testContextRule(rule: { phrase: string; scope?: string; match?: string }, c: Candidate): boolean {
  const p = String(rule.phrase ?? "");
  if (p.length < 3) return false;
  const hay = ruleHaystack(c, String(rule.scope || "any").toLowerCase());
  if (!hay) return false;
  const match = String(rule.match || "contains").toLowerCase();
  if (match === "regex") {
    const rx = compileDotNetRegex(p, true);
    return rx ? rx.test(hay) : false;
  }
  if (match === "word") {
    const rx = compileDotNetRegex("\\b" + escapeRegex(p.toLowerCase()) + "\\b", false);
    return rx ? rx.test(hay) : false;
  }
  return hay.includes(p.toLowerCase());
}

// ------------------------------------------------------ address evidence

const ADDR_RX = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
const ORIGINATOR_PATTERNS: Array<{ w: number; p: string }> = [
  { w: 1.0, p: "(?im)^\\s*From:[^\\r\\n]*?(" + ADDR_RX + ")" },
  { w: 0.95, p: "(?im)^\\s*Reply-To:[^\\r\\n]*?(" + ADDR_RX + ")" },
  { w: 0.9, p: "(?im)^\\s*On\\s.{0,90}?[<\\s(](" + ADDR_RX + ")[>\\s)]?.{0,25}wrote:" },
  { w: 0.85, p: "(?i)mailto:(" + ADDR_RX + ")" },
  { w: 0.55, p: "(?i)(" + ADDR_RX + ")" },
];

export function getBodyOriginators(body: string, limit = 12): Array<{ addr: string; weight: number }> {
  const out: Array<{ addr: string; weight: number }> = [];
  const seen = new Set<string>();
  if (!body) return out;
  for (const pat of ORIGINATOR_PATTERNS) {
    // .NET: (?m) ^ matches after \n only; '.' excludes \n only. JS 'm' also
    // treats \r as a line break for ^ — normalise CRLF so both agree.
    const rx = compileDotNetRegex(pat.p, false, true)!;
    const text = body.replace(/\r\n/g, "\n");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (m[0] === "") rx.lastIndex++;
      let a = m[1].toLowerCase().trim();
      a = a.replace(/\.+$/, "");
      if (!a.includes("@")) continue;
      if (seen.has(a)) continue;
      seen.add(a);
      out.push({ addr: a, weight: pat.w });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------- knowledge views

class KeyMap<T> {
  private m = new Map<string, T>();
  set(k: string, v: T) {
    this.m.set(k.toLowerCase(), v);
  }
  get(k: string): T | undefined {
    return this.m.get(String(k ?? "").toLowerCase());
  }
  has(k: string): boolean {
    return this.m.has(String(k ?? "").toLowerCase());
  }
}

function learnedLookup(bucket: Record<string, LearnedEntry> | undefined, key: string): LearnedEntry | undefined {
  if (!bucket) return undefined;
  if (Object.prototype.hasOwnProperty.call(bucket, key)) return bucket[key];
  const lk = key.toLowerCase();
  for (const k of Object.keys(bucket)) if (k.toLowerCase() === lk) return bucket[k];
  return undefined;
}

const splitCache = new WeakMap<LearnedStore, Map<string, string[]>>();
export function getSplitDomains(learned: LearnedStore | null): Map<string, string[]> {
  if (!learned) return new Map();
  const cached = splitCache.get(learned);
  if (cached) return cached;
  const claims = new Map<string, string[]>();
  for (const addr of Object.keys(learned.senders)) {
    if (!addr.includes("@")) continue;
    const d = addr.split("@").pop()!.toLowerCase();
    const c = String(learned.senders[addr].customer);
    const list = claims.get(d) ?? [];
    if (!list.some((x) => x.toLowerCase() === c.toLowerCase())) list.push(c);
    claims.set(d, list);
  }
  const split = new Map<string, string[]>();
  for (const [d, list] of claims) if (list.length > 1) split.set(d, list);
  splitCache.set(learned, split);
  return split;
}

/** Call after mutating a LearnedStore so the split-domain view is rebuilt. */
export function invalidateSplitDomains(learned: LearnedStore) {
  splitCache.delete(learned);
}

function resolveAddressToCustomer(
  addr: string,
  mapping: MappingRow[],
  learned: LearnedStore | null,
  byKey: KeyMap<MappingRow>,
  multiTerritory: string[],
): { customer: string; base: number; via: string } | null {
  if (!addr || !addr.includes("@")) return null;
  const dom = addr.split("@").pop()!;
  if (learned) {
    const ls = learnedLookup(learned.senders, addr);
    if (ls && byKey.has(ls.customer)) return { customer: String(ls.customer), base: 0.96, via: "learned-sender" };
  }
  if (testDomainInList(dom, multiTerritory)) return null;
  const hitKeys: string[] = [];
  for (const row of mapping) {
    for (const d of row.senderDomains) {
      if (dom === d || dom.endsWith("." + d)) {
        hitKeys.push(row.customerKey);
        break;
      }
    }
  }
  const uniq = Array.from(new Set(hitKeys));
  if (uniq.length === 1) return { customer: uniq[0], base: 0.92, via: "rule-domain" };
  if (uniq.length > 1) return null;
  if (learned) {
    const split = getSplitDomains(learned);
    if (split.has(dom)) return null;
    const ld = learnedLookup(learned.domains, dom);
    if (ld && byKey.has(ld.customer)) return { customer: String(ld.customer), base: 0.85, via: "learned-domain" };
  }
  return null;
}

interface Vote {
  best: number;
  via: string;
  ev: string;
  ruleId: string;
  n: number;
}
function addContextVote(votes: Map<string, Vote>, key: string, score: number, via: string, ev: string, ruleId = "") {
  const k = key; // customer keys come from the mapping; compare case-insensitively below
  const existingKey = Array.from(votes.keys()).find((x) => x.toLowerCase() === k.toLowerCase());
  if (!existingKey) {
    votes.set(k, { best: score, via, ev, ruleId, n: 1 });
  } else {
    const v = votes.get(existingKey)!;
    v.n++;
    if (score > v.best) {
      v.best = score;
      v.via = via;
      v.ev = ev;
      v.ruleId = ruleId;
    }
  }
}
function voteScore(v: Vote): number {
  return Math.min(0.99, v.best + Math.min(0.03, 0.01 * (v.n - 1)));
}

export function findMultiRoute(c: Candidate, rules: MultiRoute[], byKey: KeyMap<MappingRow>) {
  if (!rules || rules.length === 0) return null;
  const addr = String(c.senderAddress ?? "").trim().toLowerCase();
  const dom = addr.includes("@") ? addr.split("@").pop()! : "";
  for (const kind of ["sender", "domain", "phrase"] as const) {
    for (const r of rules) {
      if (String(r.kind) !== kind) continue;
      const v = String(r.value ?? "").toLowerCase();
      let hit = false;
      if (kind === "sender") hit = !!addr && addr === v;
      else if (kind === "domain") hit = !!dom && (dom === v || dom.endsWith("." + v));
      else hit = testContextRule({ phrase: String(r.value), scope: String(r.scope || ""), match: String(r.match || "") }, c);
      if (!hit) continue;
      const valid = (r.teams ?? []).filter((t) => byKey.has(String(t)));
      if (valid.length >= 1) return { rule: r, validTeams: valid.map((t) => byKey.get(t)!.customerKey) };
    }
  }
  return null;
}

// ------------------------------------------------------------- classifier

export function classify(c: Candidate, k: Knowledge, cfg: ClassifyConfig): Decision {
  const { mapping, learned } = k;
  const senderAddr = String(c.senderAddress ?? "").trim().toLowerCase();
  const senderDomain = senderAddr.includes("@") ? senderAddr.split("@").pop()! : "";
  const senderIgnored = testDomainInList(senderDomain, cfg.ignoredDomains);
  const contentOnlySender = !!senderAddr && cfg.contentOnly.map((x) => x.toLowerCase()).includes(senderAddr);
  const stem = () => newFileStem(c, cfg.stampMode, cfg.stemMax);
  const base = { id: c.id, alsoCustomers: [] as string[], alsoDestinations: [] as string[] };

  // ---- v4.4.3 skip internal replies
  if (cfg.skipInternalReplies && senderIgnored) {
    const subj = String(c.subject ?? "").trim();
    const isReply = /^\s*(re|r|aw|sv|antw)\s*:/i.test(subj);
    const isFwd = /^\s*(fw|fwd|wg|tr)\s*:/i.test(subj);
    const realAtt = (c.attachmentNames ?? []).filter((a) => a && !/\.(png|gif|jpg|jpeg|bmp|ico)$/i.test(a));
    if (isReply && !isFwd && realAtt.length === 0) {
      return { ...base, customerKey: "SKIPPED", confidence: 1.0, destinationRelPath: "", stem: stem(),
        matchSource: "skip-internal-reply", evidence: senderAddr, ambiguity: "", ruleId: "" };
    }
  }

  // ---- v4.5.2 auto-ignore by subject
  if (cfg.autoIgnore && cfg.autoIgnore.patterns.length) {
    for (const pat of cfg.autoIgnore.patterns) {
      const rx = compileDotNetRegex(pat, true);
      if (rx && rx.test(String(c.subject ?? ""))) {
        return { ...base, customerKey: "IGNORED", confidence: 1.0, destinationRelPath: cfg.autoIgnore.folder,
          stem: stem(), matchSource: "auto-ignore", evidence: `subject matches ${pat}`, ambiguity: "", ruleId: "" };
      }
    }
  }

  const byKey = new KeyMap<MappingRow>();
  for (const row of mapping) byKey.set(row.customerKey, row);

  // ---- v4.5 multi-folder rule
  if (k.multiRoutes && k.multiRoutes.length) {
    const mr = findMultiRoute(c, k.multiRoutes, byKey);
    if (mr) {
      const teams = mr.validTeams;
      return {
        id: c.id, customerKey: teams[0], confidence: 0.99, destinationRelPath: byKey.get(teams[0])!.folderPath,
        stem: stem(), matchSource: "multi-route", evidence: `${mr.rule.kind} ${mr.rule.value}`, ambiguity: "",
        ruleId: String(mr.rule.id), alsoCustomers: teams.slice(1),
        alsoDestinations: teams.slice(1).map((t) => byKey.get(t)!.folderPath),
      };
    }
  }

  const senderMulti = testDomainInList(senderDomain, cfg.multiTerritory);
  const haystack = `${c.subject ?? ""} ${c.body ?? ""} ${(c.attachmentNames ?? []).join(" ")}`.toLowerCase();

  let best: MappingRow | null = null;
  let bestScore = 0.0;
  let source = "";
  let evidence = "";
  let ambiguous = "";
  let ruleId = "";
  let ambiguousDomain = "";

  // ---- v4.4 internal sender route
  let routed = false;
  if (!contentOnlySender && senderAddr && Object.prototype.hasOwnProperty.call(k.internalRoutes, senderAddr)) {
    const rc = String(k.internalRoutes[senderAddr]);
    if (byKey.has(rc)) {
      best = byKey.get(rc)!;
      bestScore = 0.97;
      source = "internal-sender";
      evidence = senderAddr;
      routed = true;
    }
  }

  // ---- rule stage (mapping domains + keywords); ties between customers cancel
  let tie = false;
  for (const row of mapping) {
    let domainHit = false;
    if (!senderIgnored && !senderMulti && !contentOnlySender) {
      for (const d of row.senderDomains) {
        if (senderDomain === d || senderDomain.endsWith("." + d)) {
          domainHit = true;
          break;
        }
      }
    }
    let hits = 0;
    for (const kw of row.keywords) if (haystack.includes(kw)) hits++;
    let score = 0.0;
    let src = "";
    if (domainHit) {
      score = Math.min(0.99, 0.9 + 0.03 * hits);
      src = "rule-domain";
    } else if (hits > 0) {
      score = Math.min(0.85, 0.4 + 0.15 * hits);
      src = "rule-keywords";
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
      source = src;
      tie = false;
    } else if (score > 0 && score === bestScore && best && best.customerKey.toLowerCase() !== row.customerKey.toLowerCase()) {
      tie = true;
    }
  }
  if (tie) {
    ambiguous = `sender domain '${senderDomain}' is mapped to more than one customer`;
    ambiguousDomain = senderDomain;
    best = null;
    bestScore = 0.0;
    source = "";
  }
  if (best && source === "rule-domain") evidence = senderDomain;

  // ---- learned overlay (external senders only)
  if (learned && !senderIgnored && !contentOnlySender) {
    if (senderAddr) {
      const ls = learnedLookup(learned.senders, senderAddr);
      if (ls && byKey.has(ls.customer) && 0.96 > bestScore) {
        best = byKey.get(ls.customer)!;
        bestScore = 0.96;
        source = "learned-sender";
        evidence = senderAddr;
      }
    }
    const split = getSplitDomains(learned);
    if (senderMulti) {
      if (!best) ambiguous = `'${senderDomain}' is a multi-territory domain - only a known person or the message content can decide`;
    } else if (senderDomain && senderDomain !== ambiguousDomain && !split.has(senderDomain)) {
      const ld = learnedLookup(learned.domains, senderDomain);
      if (ld && byKey.has(ld.customer) && 0.85 > bestScore) {
        best = byKey.get(ld.customer)!;
        bestScore = 0.85;
        source = "learned-domain";
        evidence = senderDomain;
      }
    } else if (senderDomain && split.has(senderDomain) && !best) {
      ambiguous = `learned senders at '${senderDomain}' split across ${split.get(senderDomain)!.join(", ")} - no domain-level answer exists`;
    }
  } else if (senderMulti && !best) {
    ambiguous = `'${senderDomain}' is a multi-territory domain - only a known person or the message content can decide`;
  }

  // ---- context stage
  if (bestScore < 0.9 || routed) {
    const votes = new Map<string, Vote>();
    for (const o of getBodyOriginators(String(c.body ?? ""))) {
      if (o.addr === senderAddr) continue;
      const d2 = o.addr.split("@").pop()!;
      if (testDomainInList(d2, cfg.ignoredDomains)) continue;
      if (testDomainInList(d2, cfg.neverContext)) continue;
      const r = resolveAddressToCustomer(o.addr, mapping, learned, byKey, cfg.multiTerritory);
      if (!r) continue;
      addContextVote(votes, r.customer, roundHalfEven(r.base * o.weight, 3), r.via, o.addr);
    }
    for (const rule of k.ctxRules ?? []) {
      if (!byKey.has(String(rule.customer))) continue;
      if (!testContextRule(rule, c)) continue;
      addContextVote(votes, String(rule.customer), Number(rule.weight), "rule", `'${rule.phrase}'`, String(rule.id));
    }
    if (votes.size > 0) {
      const scored = Array.from(votes.entries())
        .map(([key, v]) => ({ key, score: voteScore(v), v }))
        .sort((a, b) => b.score - a.score);
      const top = scored[0];
      const runner = scored.length > 1 ? scored[1].score : 0.0;
      let clear = runner <= 0 || top.score >= runner * cfg.margin;
      if (!senderIgnored && top.score < cfg.externalContextFloor) {
        ambiguous = `body names ${top.key} (${top.v.ev}) but only weakly - external sender, below the ${cfg.externalContextFloor} floor`;
        clear = false;
      } else if (senderIgnored && !routed && top.score < cfg.externalContextFloor) {
        ambiguous = `internal sender ${senderAddr} has no route and the message only weakly names ${top.key} (${top.v.ev}) - route this address to its team`;
        clear = false;
      }
      if (clear && top.score > bestScore && byKey.has(top.key)) {
        best = byKey.get(top.key)!;
        bestScore = top.score;
        source = `context-${top.v.via}`;
        evidence = top.v.ev;
        ruleId = top.v.ruleId;
      } else if (!clear && scored.length > 1) {
        ambiguous = `content names both ${top.key} (${top.v.ev}) and ${scored[1].key} (${scored[1].v.ev}) - teach a rule to break the tie`;
      }
    }
  }

  let key: string;
  let dest: string;
  if (best && bestScore >= cfg.threshold) {
    key = best.customerKey;
    dest = best.folderPath;
    ambiguous = "";
  } else {
    key = "UNROUTED";
    dest = cfg.unroutedFolder;
    source = "";
    ruleId = "";
    if (contentOnlySender && !ambiguous) {
      ambiguous = `system sender ${senderAddr} (website orders) - routed by content only; teach the customer name or customer number as a phrase`;
    }
  }
  return {
    ...base, customerKey: key, confidence: roundHalfEven(bestScore, 2), destinationRelPath: dest, stem: stem(),
    matchSource: source, evidence, ambiguity: ambiguous, ruleId,
  };
}

// ------------------------------------------------------------- learning

export interface FiledResult {
  senderAddress: string;
  customerKey: string;
  confidence: number;
  matchSource: string;
  filed: boolean; // status copied_and_flagged on desktop
}

/**
 * Update-LearnedFromResults (v4.5.2). Mutates `learned`; returns the number of
 * emails that taught something. `now` is passed in to keep the module pure.
 */
export function updateLearnedFromResults(
  learned: LearnedStore,
  results: FiledResult[],
  opts: {
    ignoredDomains: string[];
    minConf: number; // learn_min_confidence, 0.9
    neverLearn: string[]; // = never-context list on desktop
    multiTerritory: string[];
    contentOnly: string[];
    root?: string;
    runId?: string;
    now: string;
  },
): number {
  let n = 0;
  for (const r of results) {
    if (!r.filed) continue;
    const ck = String(r.customerKey ?? "");
    if (!ck || ck === "UNROUTED" || ck === "IGNORED" || ck === "SKIPPED") continue;
    const src = String(r.matchSource ?? "");
    if (src.startsWith("context-") || src.startsWith("body-")) continue;
    if (src === "multi-route" || src === "auto-ignore") continue;
    if (Number(r.confidence) < opts.minConf) continue;
    const addr = String(r.senderAddress ?? "").trim().toLowerCase();
    if (!addr) continue;
    const dom = addr.includes("@") ? addr.split("@").pop()! : "";
    if (opts.contentOnly.map((x) => x.toLowerCase()).includes(addr)) continue;
    if (dom && testDomainInList(dom, opts.ignoredDomains)) continue;
    if (dom && testDomainInList(dom, opts.neverLearn)) continue;
    const cur = learnedLookup(learned.senders, addr);
    if (cur && ["taught", "corrected"].includes(String(cur.source)) && cur.customer.toLowerCase() !== ck.toLowerCase()) continue;
    setLearnedEntry(learned, "senders", addr, ck, "auto", opts.now, opts.root, opts.runId);
    if (dom && !isFreeMailDomain(dom) && !testDomainInList(dom, opts.multiTerritory)) {
      const cd = learnedLookup(learned.domains, dom);
      if (!(cd && ["taught", "corrected"].includes(String(cd.source)) && cd.customer.toLowerCase() !== ck.toLowerCase())) {
        setLearnedEntry(learned, "domains", dom, ck, "auto", opts.now, opts.root, opts.runId);
      }
    }
    n++;
  }
  invalidateSplitDomains(learned);
  return n;
}

export function setLearnedEntry(
  learned: LearnedStore,
  bucket: "senders" | "domains",
  key: string,
  customer: string,
  source: string,
  now: string,
  root = "",
  run = "",
): LearnedEntry {
  const store = learned[bucket];
  const existingKey = Object.keys(store).find((x) => x.toLowerCase() === key.toLowerCase()) ?? key;
  const cur = store[existingKey];
  if (cur && cur.customer.toLowerCase() === customer.toLowerCase()) {
    cur.count = Number(cur.count) + 1;
    cur.last = now;
    cur.run = run;
    if (source === "taught" || source === "corrected") cur.source = source;
    if (!cur.root) cur.root = root;
    return cur;
  }
  const keep = cur ? Math.max(1, Number(cur.count)) : 1;
  const n: LearnedEntry = {
    customer, count: source === "taught" || source === "corrected" ? keep : 1, source,
    first: now, last: now, root, run,
  };
  if (existingKey !== key) delete store[existingKey];
  store[key] = n;
  invalidateSplitDomains(learned);
  return n;
}

/**
 * Invoke-LearnedPromotion (v4.5.2): learned domains seen `promoteAfter`+ times
 * become mapping domain rules, unless senders at that domain file to more than
 * one team. Mutates `mapping`; returns { promoted, blocked } as text lines.
 */
export function promoteLearnedDomains(
  learned: LearnedStore,
  mapping: MappingRow[],
  opts: { promoteAfter: number; ignoredDomains: string[]; neverLearn: string[]; multiTerritory: string[] },
): { promoted: Array<{ domain: string; customer: string }>; blocked: string[] } {
  const promoteAfter = opts.promoteAfter < 1 ? 3 : opts.promoteAfter;
  const promoted: Array<{ domain: string; customer: string }> = [];
  const blocked: string[] = [];
  const allDomains = new Map<string, string>();
  for (const row of mapping) for (const d of row.senderDomains) allDomains.set(d, row.customerKey);
  const byKey = new KeyMap<MappingRow>();
  for (const row of mapping) byKey.set(row.customerKey, row);
  const senderClaims = new Map<string, string[]>();
  for (const addr of Object.keys(learned.senders)) {
    if (!addr.includes("@")) continue;
    const d = addr.split("@").pop()!;
    const c = String(learned.senders[addr].customer);
    const list = senderClaims.get(d) ?? [];
    if (!list.some((x) => x.toLowerCase() === c.toLowerCase())) list.push(c);
    senderClaims.set(d, list);
  }
  for (const k of Object.keys(learned.domains)) {
    const e = learned.domains[k];
    if (testDomainInList(k, opts.ignoredDomains)) continue;
    if (testDomainInList(k, opts.neverLearn)) continue;
    if (testDomainInList(k, opts.multiTerritory)) continue;
    if (isFreeMailDomain(k)) continue;
    if (Number(e.count) < promoteAfter) continue;
    if (allDomains.has(k)) continue;
    if (!byKey.has(e.customer)) continue;
    const claims = senderClaims.get(k) ?? [];
    if (claims.length > 1) {
      blocked.push(`${k} -> ${e.customer} BLOCKED: senders here also file to ${claims.filter((x) => x.toLowerCase() !== e.customer.toLowerCase()).join(", ")}`);
      continue;
    }
    const row = byKey.get(e.customer)!;
    row.senderDomains.push(k);
    allDomains.set(k, e.customer);
    promoted.push({ domain: k, customer: row.customerKey });
  }
  return { promoted, blocked };
}

// ----------------------------------------------------- config from settings

export function buildClassifyConfig(s: Record<string, unknown>): ClassifyConfig {
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const margin = num(s.context_margin, 1.35);
  const floor = num(s.external_context_floor, 0.85);
  const stamp = String(s.filename_stamp ?? "suffix").toLowerCase();
  const stemMax = Math.min(200, Math.max(40, Math.trunc(num(s.filename_max_chars, 120))));
  const pats = String(s.ignore_subject_patterns ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => compileDotNetRegex(p, true) !== null);
  const folder = String(s.ignored_folder ?? "Ignored").trim() || "Ignored";
  const never = Array.from(new Set([...NEVER_CONTEXT_BUILT_IN, ...splitList(s.never_context_domains)]));
  const sir = s.skip_internal_replies;
  return {
    threshold: num(s.confidence_threshold, 0.7),
    unroutedFolder: String(s.unrouted_folder ?? "Unrouted"),
    ignoredDomains: splitList(s.ignored_domains),
    neverContext: never,
    margin: margin > 1 ? margin : 1.35,
    externalContextFloor: floor > 0 ? floor : 0.85,
    multiTerritory: splitList(s.multi_territory_domains),
    stampMode: (["suffix", "prefix", "none"].includes(stamp) ? stamp : "suffix") as ClassifyConfig["stampMode"],
    stemMax,
    skipInternalReplies: sir === undefined || sir === null ? true : ["true", "1", "yes", "on"].includes(String(sir).toLowerCase()),
    contentOnly: splitList(s.content_only_senders),
    autoIgnore: { patterns: pats, folder },
  };
}

/** Desktop enumerate filters: excluded domains / senders never become candidates. */
export function isExcluded(senderAddress: string, s: Record<string, unknown>): "excluded-domain" | "excluded-sender" | null {
  const a = String(senderAddress ?? "").trim().toLowerCase();
  if (testDomainInList(domainOf(a), splitList(s.excluded_domains))) return "excluded-domain";
  if (a && splitList(s.excluded_senders).includes(a)) return "excluded-sender";
  return null;
}
