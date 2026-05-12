// P21 Data API (REST) client.
//
// The agent runs on the P21 server itself, so we target the local middleware
// install over loopback. We hold one access token in memory and refresh it
// when it nears expiry — P21 tokens are typically valid for ~1 hour but the
// exact lifetime is server-side, so we treat any 401 as a signal to refresh.
//
// Protocol (P21 Data API):
//   1. POST  {base}/api/security/token        headers: username, password, Authorization=<consumer_key>
//      → { AccessToken: "<jwt>", ... }
//   2. GET   {base}/data/erp/views/v1/<View>  headers: Authorization=<AccessToken>
//      → { value: [...], "@odata.count": n }
//
// If your P21 install puts the consumer key in a different header (e.g.
// `consumer-key` or `apiKey`), set P21_API_CONSUMER_KEY_HEADER accordingly.

const {
  P21_API_BASE_URL,
  P21_API_CONSUMER_KEY,
  P21_API_CONSUMER_KEY_HEADER = "Authorization",
  P21_API_USERNAME,
  P21_API_PASSWORD,
} = process.env;

function assertConfigured() {
  const missing = [];
  if (!P21_API_BASE_URL) missing.push("P21_API_BASE_URL");
  if (!P21_API_CONSUMER_KEY) missing.push("P21_API_CONSUMER_KEY");
  if (!P21_API_USERNAME) missing.push("P21_API_USERNAME");
  if (!P21_API_PASSWORD) missing.push("P21_API_PASSWORD");
  if (missing.length) {
    throw new Error(
      `P21 REST API not configured. Missing env vars: ${missing.join(", ")}. ` +
        `See agent/.env.example.`
    );
  }
}

let cachedToken = null; // { token, fetchedAt }
const TOKEN_TTL_MS = 50 * 60 * 1000; // refresh after 50 min, P21 default is ~60

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function fetchToken() {
  assertConfigured();
  const url = joinUrl(P21_API_BASE_URL, "api/security/token");
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    username: P21_API_USERNAME,
    password: P21_API_PASSWORD,
    [P21_API_CONSUMER_KEY_HEADER]: P21_API_CONSUMER_KEY,
  };
  const res = await fetch(url, { method: "POST", headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`P21 token request failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`P21 token response was not JSON: ${text.slice(0, 300)}`);
  }
  const token = json.AccessToken ?? json.access_token ?? json.token;
  if (!token) {
    throw new Error(`P21 token response missing AccessToken: ${text.slice(0, 300)}`);
  }
  cachedToken = { token, fetchedAt: Date.now() };
  return token;
}

async function getToken({ force = false } = {}) {
  if (!force && cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS) {
    return cachedToken.token;
  }
  return fetchToken();
}

function buildQueryString(params) {
  if (!params || Object.keys(params).length === 0) return "";
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    // OData params come pre-formatted (e.g. "$filter": "name eq 'foo'")
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

async function odataGet(viewPath, query) {
  assertConfigured();
  // viewPath is like "P21Sales" or "P21Customers" — we mount it under the
  // standard ERP views route.
  if (!viewPath || typeof viewPath !== "string") {
    throw new Error("viewPath is required (e.g. 'P21Customers')");
  }
  if (viewPath.includes("..") || viewPath.startsWith("/")) {
    throw new Error("viewPath must be a relative view name");
  }

  const path = `data/erp/views/v1/${viewPath}${buildQueryString(query)}`;
  const url = joinUrl(P21_API_BASE_URL, path);

  const doRequest = async (token) => {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: token,
      },
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  let token = await getToken();
  let { status, text } = await doRequest(token);
  if (status === 401) {
    // Token may be expired/revoked — refresh once and retry.
    token = await getToken({ force: true });
    ({ status, text } = await doRequest(token));
  }
  if (status < 200 || status >= 300) {
    throw new Error(`P21 OData ${viewPath} failed: ${status} ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`P21 OData ${viewPath} returned non-JSON: ${text.slice(0, 300)}`);
  }
}

// ─── Job handlers ──────────────────────────────────────────────────────────

// payload: {} — round-trips the token endpoint to prove credentials work.
export async function p21ApiTest() {
  const token = await getToken({ force: true });
  return {
    ok: true,
    baseUrl: P21_API_BASE_URL,
    tokenPrefix: `${token.slice(0, 12)}…`,
    fetchedAt: new Date(cachedToken.fetchedAt).toISOString(),
  };
}

// payload: { view: "P21Customers", query?: { "$filter": "...", "$top": 50, ... } }
export async function p21ApiQuery(payload) {
  const { view, query } = payload ?? {};
  const data = await odataGet(view, query);
  // P21 OData responses are { value: [...], "@odata.count"?: n }
  const rows = Array.isArray(data?.value) ? data.value : [];
  return {
    rows,
    count: data?.["@odata.count"] ?? rows.length,
  };
}
