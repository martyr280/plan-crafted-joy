import "dotenv/config";
import { createHmac } from "node:crypto";
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

const VERSION = "1.0.0";
const pollMs = Number(POLL_INTERVAL_MS);

function sign(bodyText) {
  const ts = Date.now();
  const sig = createHmac("sha256", BRIDGE_SECRET).update(`${ts}.${bodyText}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

async function call(action, extra = {}) {
  const body = JSON.stringify({ action, agent: { name: AGENT_NAME, version: VERSION }, ...extra });
  const res = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-signature": sign(body) },
    body,
  });
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

async function tick() {
  try {
    await call("heartbeat");
    const { jobs } = await call("claim", { limit: 5 });
    for (const job of jobs ?? []) await runJob(job);
  } catch (e) {
    console.error("tick error:", e?.message ?? e);
  }
}

console.log(`NDI P21 Bridge Agent "${AGENT_NAME}" v${VERSION}`);
console.log(`Polling ${BRIDGE_URL} every ${pollMs}ms`);
console.log(`Available job kinds: ${Object.keys(handlers).join(", ")}`);

await tick();
setInterval(tick, pollMs);
