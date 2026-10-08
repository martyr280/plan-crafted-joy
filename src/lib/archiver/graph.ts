/**
 * Minimal Microsoft Graph client for Order Mail. Two auth modes:
 *  - "gateway": the Lovable connector gateway (microsoft_outlook), delegated
 *    OAuth of whoever linked the connector. No secrets in code. Same pattern as
 *    truck-capacity/workbook-sync.server.ts.
 *  - "app": an Entra app registration (client credentials), scoped by NDI IT to
 *    one mailbox with RBAC for Applications. The production option.
 * fetch and sleep are injected so tests run offline.
 */

export type GraphAuth =
  | { kind: "gateway"; lovableKey: string; connectionKey: string; connectorId?: string }
  | { kind: "app"; tenantId: string; clientId: string; clientSecret: string };

export interface GraphMessageMeta {
  id: string;
  receivedDateTime: string;
  internetMessageId?: string;
  subject?: string;
  sender?: { emailAddress?: { address?: string; name?: string } };
  from?: { emailAddress?: { address?: string; name?: string } };
  hasAttachments?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  webLink?: string;
  "@removed"?: unknown;
}

export const GATEWAY = "https://connector-gateway.lovable.dev";
const GRAPH = "https://graph.microsoft.com/v1.0";
const DELTA_SELECT = "id,receivedDateTime,internetMessageId,subject,sender,from,hasAttachments,flag,categories,webLink";

export class GraphError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class GraphClient {
  private token: { value: string; exp: number } | null = null;
  constructor(
    private auth: GraphAuth,
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async appToken(): Promise<string> {
    if (this.auth.kind !== "app") throw new Error("not app auth");
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.auth.clientId, client_secret: this.auth.clientSecret,
      scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
    });
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${this.auth.tenantId}/oauth2/v2.0/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new GraphError(res.status, `token request failed: ${j.error_description ?? j.error ?? res.status}`);
    this.token = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** path is a Graph v1.0 path ("/users/x/mailFolders") or an absolute nextLink/deltaLink. */
  async request(method: string, path: string, opts: { body?: unknown; prefer?: string[]; accept?: string } = {}): Promise<Response> {
    let url: string;
    const headers: Record<string, string> = {};
    if (opts.prefer?.length) headers["Prefer"] = opts.prefer.join(", ");
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.accept) headers["Accept"] = opts.accept;
    const rel = path.startsWith(GRAPH) ? path.slice(GRAPH.length) : path;
    if (this.auth.kind === "gateway") {
      const gw = `${GATEWAY}/${this.auth.connectorId ?? "microsoft_outlook"}`;
      url = rel.startsWith("http") ? rel.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, gw) : gw + rel;
      headers["Authorization"] = `Bearer ${this.auth.lovableKey}`;
      headers["X-Connection-Api-Key"] = this.auth.connectionKey;
    } else {
      url = rel.startsWith("http") ? rel : GRAPH + rel;
      headers["Authorization"] = `Bearer ${await this.appToken()}`;
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 4) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && this.auth.kind === "app" && attempt === 0) {
        this.token = null;
        headers["Authorization"] = `Bearer ${await this.appToken()}`;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new GraphError(res.status, `Graph ${method} ${rel.split("?")[0]} failed [${res.status}]: ${text.slice(0, 300)}`);
      }
      return res;
    }
  }

  async json<T = any>(method: string, path: string, opts: { body?: unknown; prefer?: string[] } = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }

  /** Resolve "Nashville orders" or "Inbox/Orders/Nashville" under a mailbox base ("/users/x" or "/me"). */
  async resolveFolderId(base: string, folderPath: string): Promise<string> {
    const parts = folderPath.split("/").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) throw new Error("folder path is empty");
    let parentPath = `${base}/mailFolders`;
    let id = "";
    for (let i = 0; i < parts.length; i++) {
      const want = parts[i].toLowerCase();
      let next: string | undefined = `${parentPath}?$select=id,displayName&$top=100&includeHiddenFolders=true`;
      let found: any = null;
      while (next && !found) {
        const page: any = await this.json("GET", next);
        found = (page.value ?? []).find((f: any) => String(f.displayName ?? "").toLowerCase() === want);
        next = page["@odata.nextLink"];
      }
      if (!found && i === 0) {
        // Well-known names (inbox, sentitems...) resolve directly.
        try {
          found = await this.json("GET", `${base}/mailFolders/${encodeURIComponent(want)}?$select=id,displayName`);
        } catch {
          found = null;
        }
      }
      if (!found) throw new Error(`mail folder '${parts.slice(0, i + 1).join("/")}' not found in ${base}`);
      id = found.id;
      parentPath = `${base}/mailFolders/${id}/childFolders`;
    }
    return id;
  }

  /** One page of folder delta. Pass the stored link, or null with sinceIso for the first sync. */
  async deltaPage(base: string, folderId: string, link: string | null, sinceIso: string | null) {
    const first = `${base}/mailFolders/${folderId}/messages/delta?$select=${DELTA_SELECT}` +
      (sinceIso ? `&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` : "");
    const page: any = await this.json("GET", link ?? first, { prefer: ['IdType="ImmutableId"', "odata.maxpagesize=50"] });
    return {
      messages: (page.value ?? []) as GraphMessageMeta[],
      nextLink: (page["@odata.nextLink"] as string | undefined) ?? null,
      deltaLink: (page["@odata.deltaLink"] as string | undefined) ?? null,
    };
  }

  async getBodyText(base: string, id: string): Promise<string> {
    const m: any = await this.json("GET", `${base}/messages/${id}?$select=body`, {
      prefer: ['IdType="ImmutableId"', 'outlook.body-content-type="text"'],
    });
    return String(m?.body?.content ?? "");
  }

  async getAttachmentNames(base: string, id: string): Promise<string[]> {
    const out: string[] = [];
    let next: string | undefined = `${base}/messages/${id}/attachments?$select=name,isInline`;
    while (next) {
      const page: any = await this.json("GET", next, { prefer: ['IdType="ImmutableId"'] });
      for (const a of page.value ?? []) if (a?.name) out.push(String(a.name));
      next = page["@odata.nextLink"];
    }
    return out;
  }

  /** RFC 822 MIME of the message (what is written to O: as .eml). */
  async getMime(base: string, id: string): Promise<ArrayBuffer> {
    const res = await this.request("GET", `${base}/messages/${id}/$value`, { prefer: ['IdType="ImmutableId"'] });
    return await res.arrayBuffer();
  }

  /** Desktop "processed" marker: a follow-up flag (processed_marker = flag). */
  async markProcessed(base: string, id: string, mode: "flag" | "category" | "both", category: string, existing: string[] = []) {
    const body: any = {};
    if (mode === "flag" || mode === "both") body.flag = { flagStatus: "flagged" };
    if ((mode === "category" || mode === "both") && !existing.some((c) => c.toLowerCase() === category.toLowerCase())) {
      body.categories = [...existing, category];
    }
    await this.json("PATCH", `${base}/messages/${id}`, { body, prefer: ['IdType="ImmutableId"'] });
  }
}

export function isProcessedInOutlook(m: GraphMessageMeta, category: string): boolean {
  const fs = String(m.flag?.flagStatus ?? "notFlagged");
  if (fs === "flagged" || fs === "complete") return true;
  return (m.categories ?? []).some((c) => c.toLowerCase() === String(category).toLowerCase());
}

/** UTC ISO -> America/Chicago 'yyyy-MM-ddTHH:mm:ss' (the desktop filename stamp clock). */
export function toChicagoLocal(iso: string): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}
