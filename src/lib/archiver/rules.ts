/**
 * Validation for rules people create in the web app — ports of the desktop
 * Test-NewContextRule, Test-NewMultiRoute and the /api/internal-routes checks,
 * with the same messages so operators see familiar wording.
 *
 * One deliberate difference: "is this one of our addresses?" uses
 * settings.own_domains (default "ndiof.com") instead of ignored_domains.
 * ignored_domains is blank on purpose (routing decision, 7 Oct 2026), and on the
 * desktop that blank list made every new internal route fail validation.
 */
import { compileDotNetRegex, splitList, testContextRule, testDomainInList, type Candidate } from "./classify";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const EMAIL_LIKE = /^\s*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*$/;

export function ownDomains(settings: Record<string, unknown>): string[] {
  const l = splitList(settings.own_domains ?? "ndiof.com");
  return l.length ? l : ["ndiof.com"];
}

export function isOwnAddress(addr: string, own: string[]): boolean {
  const a = String(addr ?? "").trim().toLowerCase();
  if (!a.includes("@")) return false;
  const d = a.split("@").pop()!;
  if (testDomainInList(d, own)) return true;
  if (d.endsWith(".onmicrosoft.com")) return true;
  const lab = d.split(".")[0];
  return own.some((o) => o.split(".")[0] === lab);
}

export function validateContentRule(
  raw: { phrase?: string; team?: string; scope?: string; match?: string; weight?: number; note?: string },
  teamKeys: Set<string>,
): Result<{ phrase: string; team_key: string; scope: string; match: string; weight: number; note: string }> {
  const errors: string[] = [];
  const phrase = String(raw.phrase ?? "").trim();
  const team = String(raw.team ?? "").trim();
  const scope = String(raw.scope ?? "").trim().toLowerCase() || "any";
  const match = String(raw.match ?? "").trim().toLowerCase() || "contains";
  let w = Number(raw.weight);
  if (!(w > 0)) w = 0.94;
  if (phrase.length < 3) errors.push("Phrase must be at least 3 characters - shorter phrases match half your mail.");
  if (phrase.length > 200) errors.push("Phrase is too long (max 200 characters).");
  if (!team) errors.push("Customer is required.");
  else if (!teamKeys.has(team)) errors.push(`Unknown customer '${team}'.`);
  if (!["any", "subject", "body", "attachments"].includes(scope)) errors.push("Scope must be any, subject, body or attachments.");
  if (!["contains", "word", "regex"].includes(match)) errors.push("Match must be contains, word or regex.");
  if (w < 0.5 || w > 0.99) errors.push("Weight must be between 0.50 and 0.99.");
  if (match === "regex" && !compileDotNetRegex(phrase, true)) errors.push("Regex does not compile.");
  if (match !== "regex" && EMAIL_LIKE.test(phrase)) {
    errors.push("That is an email address - teach it as a sender instead so the forwarded-From position bonus applies.");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { phrase, team_key: team, scope, match, weight: Math.round(w * 100) / 100, note: String(raw.note ?? "").trim() } };
}

export function validateMultiRoute(
  raw: { kind?: string; value?: string; teams?: string[]; scope?: string; match?: string; note?: string },
  teamKeys: Set<string>,
  own: string[],
): Result<{ kind: "sender" | "domain" | "phrase"; value: string; team_keys: string[]; scope: string; match: string; note: string }> {
  const errors: string[] = [];
  const kind = String(raw.kind ?? "").trim().toLowerCase();
  let value = String(raw.value ?? "").trim();
  const teams = Array.from(new Set((raw.teams ?? []).map((t) => String(t).trim()).filter(Boolean)));
  const scope = String(raw.scope ?? "").trim().toLowerCase() || "any";
  const match = String(raw.match ?? "").trim().toLowerCase() || "contains";
  if (!["sender", "domain", "phrase"].includes(kind)) errors.push("Rule type must be sender, domain or phrase.");
  if (kind === "sender") {
    value = value.toLowerCase();
    if (!/^[^@\s;,]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(value)) errors.push(`'${value}' is not an email address.`);
  } else if (kind === "domain") {
    value = value.toLowerCase().replace(/^@+/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) errors.push(`'${value}' is not a domain (example: dealer.com).`);
    else if (testDomainInList(value, own)) {
      errors.push(`'${value}' is your own domain - a domain rule would send every colleague's email to these teams. Use a sender rule for one person.`);
    }
  } else if (kind === "phrase") {
    if (value.length < 3) errors.push("Phrase must be at least 3 characters.");
    if (value.length > 200) errors.push("Phrase is too long (max 200 characters).");
    if (!["any", "subject", "body", "attachments"].includes(scope)) errors.push("Look in must be any, subject, body or attachments.");
    if (!["contains", "word", "regex"].includes(match)) errors.push("Match must be contains, word or regex.");
    if (match === "regex" && !compileDotNetRegex(value, true)) errors.push("Regex does not compile.");
  }
  if (teams.length < 2) errors.push("Pick at least two teams. For one team, use Teach (remember sender / internal route / phrase).");
  for (const t of teams) if (!teamKeys.has(t)) errors.push(`Unknown team '${t}'.`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { kind: kind as any, value, team_keys: teams, scope: kind === "phrase" ? scope : "", match: kind === "phrase" ? match : "",
    note: String(raw.note ?? "").trim() } };
}

export function validateInternalRoute(
  raw: { address?: string; team?: string; note?: string },
  teamKeys: Set<string>,
  settings: Record<string, unknown>,
): Result<{ address: string; team_key: string; note: string }> {
  const addr = String(raw.address ?? "").trim().toLowerCase();
  const team = String(raw.team ?? "").trim();
  const contentOnly = splitList(settings.content_only_senders);
  if (!addr || !/^[^@\s;]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(addr)) return { ok: false, errors: ["address must be an email address."] };
  if (!team) return { ok: false, errors: ["Customer is required - pick one."] };
  if (contentOnly.includes(addr)) {
    return { ok: false, errors: [`'${addr}' is a system sender (website orders) - it is routed by content only. Teach the customer name or customer number as a phrase instead.`] };
  }
  if (!teamKeys.has(team)) return { ok: false, errors: [`Unknown customer '${team}' - add it to the mapping first.`] };
  if (!isOwnAddress(addr, ownDomains(settings))) {
    return { ok: false, errors: [`'${addr}' is not one of your own domains. Internal sender routes are for your people; an outside sender is taught as a learned sender from the Unrouted list instead.`] };
  }
  return { ok: true, value: { address: addr, team_key: team, note: String(raw.note ?? "").trim() } };
}

/** Rule preview: how many of these recent emails would a phrase have caught, and where did they go? */
export function previewPhrase(
  rule: { phrase: string; scope?: string; match?: string },
  recent: Array<Pick<Candidate, "subject" | "body" | "attachmentNames"> & { team_key: string | null }>,
): { matched: number; byTeam: Record<string, number> } {
  const byTeam: Record<string, number> = {};
  let matched = 0;
  for (const m of recent) {
    if (!testContextRule(rule, { id: "", senderAddress: "", receivedAt: "2000-01-01T00:00:00", ...m } as Candidate)) continue;
    matched++;
    const k = m.team_key ?? "UNROUTED";
    byTeam[k] = (byTeam[k] ?? 0) + 1;
  }
  return { matched, byTeam };
}

/** Chicago calendar-day bounds (UTC ISO) for "today" counts on the Overview. */
export function chicagoDayBounds(now: Date): { start: string; end: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
  const day = fmt.format(now); // yyyy-mm-dd
  const probe = (h: number) => {
    // find the UTC instant whose Chicago wall time is day 00:00 (offset is -5 or -6)
    for (const off of [5, 6]) {
      const t = new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`).getTime() + off * 3600_000;
      if (fmt.format(new Date(t)) === day && new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(new Date(t)) === "00") return t;
    }
    return new Date(`${day}T06:00:00Z`).getTime();
  };
  const start = probe(0);
  return { start: new Date(start).toISOString(), end: new Date(start + 24 * 3600_000).toISOString() };
}
