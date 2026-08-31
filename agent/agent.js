import "dotenv/config";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { handlers } from "./handlers/index.js";

const {
  BRIDGE_URL,
  BRIDGE_SECRET,
  AGENT_NAME = "ndi-agent",
  POLL_INTERVAL_MS = "5000",
} = process.env;

if (!BRIDGE_URL || !BRIDGE_SECRET) {
  console.error("Missing BRIDGE_URL or BRIDGE_SECRET. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const VERSION = "1.3.1";
const REQUEST_TIMEOUT_MS = Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS ?? 30000);
const pollMs = Number(POLL_INTERVAL_MS);

// --- Corporate TLS interception (FortiGate SSL deep inspection) -------------
// The compiled binary does not consult the Windows certificate store, and it
// ignores NODE_EXTRA_CA_CERTS. Read the CA PEM ourselves and hand it to fetch
// via the `tls` option, which the Bun runtime honours per-request. Under plain
// Node the extra option is ignored and NODE_EXTRA_CA_CERTS does the work.
const CA_PATH = process.env.BRIDGE_CA_PATH || process.env.NODE_EXTRA_CA_CERTS || "";
let extraCa = null;
if (CA_PATH) {
  try {
    extraCa = readFileSync(CA_PATH, "utf8");
    const count = (extraCa.match(/BEGIN CERTIFICATE/g) ?? []).length;
    console.log(`Loaded ${count} extra CA certificate(s) from ${CA_PATH}`);
  } catch (e) {
    console.error(`Could not read CA file ${CA_PATH}: ${e?.message ?? e}`);
  }
}
const tlsOption = extraCa ? { tls: { ca: extraCa } } : {};

function sign(bodyText) {
  const ts = Date.now();
  const sig = createHmac("sha256", BRIDGE_SECRET).update(`${ts}.${bodyText}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}


async function call(action, extra = {}) {
  const body = JSON.stringify({ action, agent: { name: AGENT_NAME, version: VERSION }, ...extra });
  // Never let a hung/blackholed connection stall the poll loop forever.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-signature": sign(body) },
      body,
      signal: ctl.signal,
    });
  } catch (e) {
    if (ctl.signal.aborted) {
      throw new Error(`bridge ${action} timed out after ${REQUEST_TIMEOUT_MS}ms (no response from ${BRIDGE_URL})`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`bridge ${action} failed: ${res.status} ${await res.text()}`);
  return res.json();
}


async function runJob(job) {
  const handler = handlers[job.kind];
  if (!handler) {
    await call("complete", { jobId: job.id, error: `Unknown job kind: ${job.kind}` });
    return;
  }
  try {
    const result = await handler(job.payload ?? {});
    await call("complete", { jobId: job.id, result });
    console.log(`[${new Date().toISOString()}] ✓ ${job.kind} (${job.id})`);
  } catch (e) {
    const msg = e?.message ?? String(e);
    await call("complete", { jobId: job.id, error: msg });
    console.error(`[${new Date().toISOString()}] ✗ ${job.kind} (${job.id}): ${msg}`);
  }
}

let ticking = false;
let lastAliveLog = 0;

async function tick() {
  if (ticking) return; // never overlap polls
  ticking = true;
  try {
    await call("heartbeat");
    // Prove liveness in the log at most once a minute, so silence always means trouble.
    if (Date.now() - lastAliveLog > 60000) {
      lastAliveLog = Date.now();
      console.error(`[${new Date().toISOString()}] heartbeat ok`);
    }
    const { jobs } = await call("claim", { limit: 5 });
    for (const job of jobs ?? []) await runJob(job);
  } catch (e) {
    console.error("tick error:", e?.message ?? e);
  } finally {
    ticking = false;
  }
}


console.log(`NDI P21 Bridge Agent "${AGENT_NAME}" v${VERSION}`);
console.log(`Polling ${BRIDGE_URL} every ${pollMs}ms`);
console.log(`Available job kinds: ${Object.keys(handlers).join(", ")}`);

await tick();
setInterval(tick, pollMs);
