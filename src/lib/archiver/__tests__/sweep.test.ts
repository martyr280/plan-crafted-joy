import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GraphClient, toChicagoLocal, isProcessedInOutlook } from "../graph";
import { destinationToTeam, mailboxBase, sweepMailbox, type MessageRow, type SweepStore } from "../sweep";
import { parseContextRules, parseInternalRoutes, parseLearned, parseMappingCsv, parseMultiRoutes } from "../import-desktop";
import type { Knowledge } from "../classify";

// Network kill-switch: every test passes its own fake fetch to GraphClient.
vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network disabled in archiver tests"); }));

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v452");
const rd = (f: string) => readFileSync(join(FX, f), "utf8");
function knowledge(): Knowledge {
  const routes: Record<string, string> = {};
  for (const r of parseInternalRoutes(rd("internal-routes.json"))) routes[r.address] = r.customer;
  return { mapping: parseMappingCsv(rd("customer-mapping.csv")), learned: parseLearned(rd("learned-routing.json")),
    ctxRules: parseContextRules(rd("context-rules.json")), internalRoutes: routes, multiRoutes: parseMultiRoutes(rd("multi-routes.json")) };
}
const SETTINGS = {
  mode: "shadow", filing_enabled: false, content_only_senders: "ndiconnect@ndiof.com", ignore_subject_patterns: "^Cart \\d+ was imported",
  excluded_senders: "sthomas@ndiof.com", excluded_domains: "arcb.com", body_chars: 4000, processed_category: "Archived",
};
const learnedSender = Object.keys(JSON.parse(rd("learned-routing.json")).senders).find((k) => k.endsWith("@everything2go.com")) ?? Object.keys(JSON.parse(rd("learned-routing.json")).senders)[0];

class MemStore implements SweepStore {
  messages: Array<MessageRow & { id: string }> = [];
  decisions: any[] = [];
  mailboxPatches: any[] = [];
  ledger = new Map<string, string>();
  async loadKnowledge() { return knowledge(); }
  async teamByFolder() {
    const m = new Map<string, string>();
    for (const t of knowledge().mapping) m.set(t.folderPath.toLowerCase(), t.customerKey);
    m.set("ignored", "IGNORED"); m.set("unrouted", "UNROUTED");
    return m;
  }
  async updateMailbox(_id: string, patch: any) { this.mailboxPatches.push(patch); }
  async existingGraphIds(ids: string[]) { return new Set(this.messages.filter((m) => ids.includes(m.graph_id)).map((m) => m.graph_id)); }
  async existingLedgerKeys(keys: string[]) { return new Set(this.messages.filter((m) => keys.includes(m.ledger_key)).map((m) => m.ledger_key)); }
  async ledgerDestinations(keys: string[]) { return new Map(keys.filter((k) => this.ledger.has(k)).map((k) => [k, this.ledger.get(k)!])); }
  async insertMessage(row: MessageRow) {
    if (this.messages.some((m) => m.ledger_key === row.ledger_key || m.graph_id === row.graph_id)) return null;
    const id = `m${this.messages.length + 1}`; this.messages.push({ ...row, id }); return { id };
  }
  async insertDecision(row: any) { this.decisions.push(row); }
}

type Route = (url: string, init: any) => { status?: number; json?: any; text?: string; headers?: Record<string, string> } | undefined;
function fakeFetch(routes: Route[], calls: Array<{ url: string; method: string; headers: any }>) {
  return (async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    for (const r of routes) {
      const hit = r(url, init);
      if (hit) {
        const status = hit.status ?? 200;
        return new Response(hit.json !== undefined ? JSON.stringify(hit.json) : (hit.text ?? ""), { status, headers: hit.headers });
      }
    }
    return new Response(`no fake route for ${url}`, { status: 404 });
  }) as unknown as typeof fetch;
}
const msg = (id: string, sender: string, subject: string, received = "2026-10-08T14:05:00Z", extra: any = {}) => ({
  id, receivedDateTime: received, internetMessageId: `<${id}@mail>`, subject, sender: { emailAddress: { address: sender, name: "N" } },
  hasAttachments: false, flag: { flagStatus: "notFlagged" }, categories: [], webLink: `https://outlook/${id}`, ...extra,
});

const GW = "https://connector-gateway.lovable.dev/microsoft_outlook";
function baseRoutes(page1: any, page2: any): Route[] {
  return [
    (u) => u.startsWith(`${GW}/users/rmcgaughy%40ndiof.com/mailFolders?`) ? { json: { value: [{ id: "INBOX", displayName: "Inbox" }, { id: "F1", displayName: "Nashville orders" }] } } : undefined,
    (u) => u === `${GW}/users/rmcgaughy%40ndiof.com/mailFolders/F1/messages/delta?$skiptoken=P2` ? { json: page2 } : undefined,
    (u) => u.startsWith(`${GW}/users/rmcgaughy%40ndiof.com/mailFolders/F1/messages/delta?$select=`) ? { json: page1 } : undefined,
    (u) => /\/messages\/[^/]+\?\$select=body$/.test(u) ? { json: { body: { contentType: "text", content: u.includes("/w1?") ? "Customer: 11859 Company Name: WHITTINGTON OFFICE FURN" : "Please ship asap" } } } : undefined,
    (u) => /\/attachments\?/.test(u) ? { json: { value: [{ name: "image001.png", isInline: true }, { name: "PO_10054.pdf", isInline: false }] } } : undefined,
  ];
}

describe("Graph client", () => {
  it("rewrites absolute Graph links onto the connector gateway and sends gateway headers", async () => {
    const calls: any[] = [];
    const g = new GraphClient({ kind: "gateway", lovableKey: "LK", connectionKey: "CK" },
      fakeFetch([(u) => (u === `${GW}/me/mailFolders/X/messages/delta?$skiptoken=1` ? { json: { value: [] } } : undefined)], calls));
    await g.json("GET", "https://graph.microsoft.com/v1.0/me/mailFolders/X/messages/delta?$skiptoken=1");
    expect(calls[0].headers).toMatchObject({ Authorization: "Bearer LK", "X-Connection-Api-Key": "CK" });
  });
  it("gets and caches an app token, then retries a 429 after Retry-After", async () => {
    const calls: any[] = [];
    let n = 0;
    const sleep = vi.fn(async () => {});
    const g = new GraphClient({ kind: "app", tenantId: "T", clientId: "C", clientSecret: "S" }, fakeFetch([
      (u) => (u.includes("login.microsoftonline.com/T/oauth2/v2.0/token") ? { json: { access_token: "AT", expires_in: 3600 } } : undefined),
      (u) => (u.startsWith("https://graph.microsoft.com/v1.0/me/x") ? (n++ === 0 ? { status: 429, headers: { "retry-after": "2" } } : { json: { ok: 1 } }) : undefined),
    ], calls), sleep);
    expect(await g.json("GET", "/me/x")).toEqual({ ok: 1 });
    await g.json("GET", "/me/x");
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    expect(calls.find((c) => c.url.startsWith("https://graph"))!.headers.Authorization).toBe("Bearer AT");
  });
  it("converts UTC to the Chicago filename clock and reads Outlook markers", () => {
    expect(toChicagoLocal("2026-10-07T14:37:45Z")).toBe("2026-10-07T09:37:45");
    expect(toChicagoLocal("2026-01-15T15:00:00Z")).toBe("2026-01-15T09:00:00");
    expect(isProcessedInOutlook({ id: "a", receivedDateTime: "", flag: { flagStatus: "complete" } }, "Archived")).toBe(true);
    expect(isProcessedInOutlook({ id: "a", receivedDateTime: "", categories: ["archived"] }, "Archived")).toBe(true);
    expect(isProcessedInOutlook({ id: "a", receivedDateTime: "", flag: { flagStatus: "notFlagged" } }, "Archived")).toBe(false);
  });
});

describe("shadow sweep", () => {
  const page1 = { value: [
    msg("c1", "ndiconnect@ndiof.com", "Cart 3029 was imported"),
    msg("x1", "sthomas@ndiof.com", "lunch?"),
    { id: "gone", "@removed": { reason: "deleted" } },
    msg("old", learnedSender, "PO old", "2026-10-07T10:00:00Z"),
  ], "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/rmcgaughy%40ndiof.com/mailFolders/F1/messages/delta?$skiptoken=P2" };
  const page2 = { value: [
    msg("w1", "ndiconnect@ndiof.com", "Web Order 77"),
    msg("d1", learnedSender, "Purchase Order 10054", "2026-10-08T14:06:00Z", { hasAttachments: true }),
  ], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/rmcgaughy%40ndiof.com/mailFolders/F1/messages/delta?$deltatoken=D1" };

  async function run(store: MemStore, mb: any, calls: any[], p1 = page1, p2 = page2) {
    const graph = new GraphClient({ kind: "gateway", lovableKey: "LK", connectionKey: "CK" }, fakeFetch(baseRoutes(p1, p2), calls));
    return sweepMailbox(mb, { store, graph, settings: SETTINGS, now: new Date("2026-10-08T14:10:00Z") });
  }
  const MB = { id: "mb1", mailbox: "rmcgaughy@ndiof.com", folder_path: "Nashville orders", folder_id: null, delta_link: null, start_at: "2026-10-08T00:00:00Z" };

  it("classifies new mail, records decisions, saves the delta link, and never writes to Outlook", async () => {
    const store = new MemStore(); const calls: any[] = [];
    store.ledger.set("mid:<d1@mail>", "#E2G");
    const c = await run(store, MB, calls);
    expect(c).toMatchObject({ pages: 2, removed: 1, before_start: 1, excluded: 1, classified: 3, delta_complete: true });
    const by = Object.fromEntries(store.messages.map((m) => [m.graph_id, m]));
    expect([by.c1.status, by.c1.team_key, by.c1.route_source]).toEqual(["ignored", "IGNORED", "auto-ignore"]);
    expect([by.x1.status, by.x1.excluded_reason]).toEqual(["excluded", "excluded-sender"]);
    expect([by.w1.status, by.w1.team_key]).toEqual(["unrouted", "UNROUTED"]);
    expect(by.w1.ambiguity).toMatch(/website orders/);
    expect(by.d1.attachment_names).toEqual(["image001.png", "PO_10054.pdf"]);
    expect(by.d1.received_local).toBe("2026-10-08T09:06:00");
    expect(by.d1.stem).toBe("Purchase Order 10054_20261008_090600");
    expect(by.d1.desktop_team_key).toBe("E2G");
    expect(store.decisions.length).toBe(3);
    expect(store.decisions.every((d) => d.mode === "shadow")).toBe(true);
    expect(store.mailboxPatches[0]).toEqual({ folder_id: "F1" });
    expect(store.mailboxPatches.at(-1).delta_link).toMatch(/deltatoken=D1$/);
    expect(calls.some((x) => x.method !== "GET")).toBe(false);
    expect(calls.find((x) => x.url.includes("/delta?"))!.url).toContain(encodeURIComponent("receivedDateTime ge 2026-10-08T00:00:00Z"));
    expect(calls.every((x) => x.url.startsWith(GW))).toBe(true);
  });

  it("second sweep on the delta link skips mail it already has and duplicate copies", async () => {
    const store = new MemStore(); const calls: any[] = [];
    await run(store, MB, calls);
    const again = { value: [msg("d1", learnedSender, "Purchase Order 10054", "2026-10-08T14:06:00Z", { flag: { flagStatus: "flagged" } }),
      msg("d1-copy", learnedSender, "Purchase Order 10054", "2026-10-08T14:06:00Z", { internetMessageId: "<d1@mail>" })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/rmcgaughy%40ndiof.com/mailFolders/F1/messages/delta?$deltatoken=D2" };
    const calls2: any[] = [];
    const graph = new GraphClient({ kind: "gateway", lovableKey: "LK", connectionKey: "CK" }, fakeFetch([
      (u) => (u.includes("deltatoken=D1") ? { json: again } : undefined), ...baseRoutes(page1, page2)], calls2));
    const c = await sweepMailbox({ ...MB, folder_id: "F1", delta_link: store.mailboxPatches.at(-1).delta_link }, { store, graph, settings: SETTINGS, now: new Date() });
    expect(c).toMatchObject({ already_known: 1, duplicate_copy: 1, classified: 0 });
    expect(store.messages.length).toBe(4);
  });

  it("maps desktop ledger destinations to teams", async () => {
    const byFolder = await new MemStore().teamByFolder();
    expect(destinationToTeam("Team Texas & LA & MS (+ copies: #E2G)", byFolder)).toBe("TEAMTEXASLAMS");
    expect(destinationToTeam("skipped:internal-reply", byFolder)).toBe("SKIPPED");
    expect(destinationToTeam("Ignored", byFolder)).toBe("IGNORED");
    expect(destinationToTeam("Somewhere else", byFolder)).toBeNull();
    expect(mailboxBase("me")).toBe("/me");
  });
});
