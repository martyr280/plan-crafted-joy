import { query } from "../sql.js";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const STORE_FILE = "order-submit-idempotency.json";

// idempotencyKey -> Promise<result> for submits currently in progress.
const inflight = new Map();

function dataDir() {
  if (process.env.AGENT_DATA_DIR) return process.env.AGENT_DATA_DIR;
  if (process.execPath) return dirname(process.execPath);
  return process.cwd();
}

function storePath() {
  return join(dataDir(), STORE_FILE);
}

function loadStore() {
  const path = storePath();
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function saveStore(store) {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}

// payload: { customerId, poNumber, lines: [{ sku, qty, unitPrice }], idempotencyKey }
export async function submitOrder(payload) {
  const { customerId, poNumber, lines, idempotencyKey } = payload ?? {};
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new Error("idempotencyKey is required (non-empty string)");
  }
  const key = idempotencyKey.trim();

  const store = loadStore();
  if (store[key]) {
    console.log(`[order.submit] replayed cached result for key=${key}`);
    return { ...store[key], replayed: true };
  }

  if (inflight.has(key)) {
    console.log(`[order.submit] coalesced concurrent submit for key=${key}`);
    const result = await inflight.get(key);
    return { ...result, replayed: true };
  }

  const promise = (async () => {
    // Re-check in case another process wrote the store meanwhile.
    const again = loadStore();
    if (again[key]) return again[key];

    if (!customerId || !Array.isArray(lines) || lines.length === 0) {
      throw new Error("customerId and lines[] are required");
    }
    // TODO: replace with the real P21 order-creation stored procedure / API.
    // This is a placeholder that returns a fake order number so the bridge can be
    // tested end-to-end before the production sproc is wired up.
    const rows = await query("SELECT GETDATE() AS now");
    const fakeOrderNo = `P21-${Math.floor(Math.random() * 900000 + 100000)}`;
    const result = {
      p21_order_id: fakeOrderNo,
      submitted_at: rows[0].now,
      customerId,
      poNumber,
      lineCount: lines.length,
    };
    again[key] = result;
    saveStore(again);
    return result;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}
