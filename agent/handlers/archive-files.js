// Order Mail file jobs: write and move archived emails on NDI's O: share.
//
// Safety model:
//  - Every path is RELATIVE to ARCHIVE_ROOT (set in .env on this server). Absolute
//    paths, drive letters, UNC prefixes and ".." segments are refused, and the
//    resolved path must still sit inside ARCHIVE_ROOT.
//  - Nothing is ever overwritten. A name clash becomes "stem (2)", "stem (3)"…,
//    exactly like the desktop Email Archiver.
//  - Files are written to "<name>.part" first and renamed into place, so a team
//    member never opens a half-written email.
//  - Every job carries an idempotencyKey. A completed result is stored locally
//    and replayed, so a retried job never files the same email twice.
//  - Files are downloaded from a short-lived signed URL and checked against the
//    sha256 the app computed before anything is renamed into place.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat, unlink, utimes, copyFile, open, readdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, resolve, sep, dirname, extname, basename } from "node:path";
import { userInfo, hostname } from "node:os";

const STORE_FILE = "archive-files-idempotency.json";
const MAX_BYTES = 150 * 1024 * 1024;
const LEDGER_REL = ".archiver/processed.log";

// ---------------------------------------------------------------- config

export function archiveRoot() {
  const r = String(process.env.ARCHIVE_ROOT ?? "").trim();
  if (!r) throw new Error("ARCHIVE_ROOT is not set in this agent's .env — Order Mail file jobs are disabled on this server.");
  return resolve(r);
}

function extraCa() {
  const p = process.env.BRIDGE_CA_PATH || process.env.NODE_EXTRA_CA_CERTS || "";
  if (!p) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// ------------------------------------------------------------ path safety

const ILLEGAL_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/** Clean a file stem the same way the desktop does (Sanitize-Stem) and cap its length. */
export function cleanStem(stem, max = 180) {
  const s = String(stem ?? "").replace(/[\\/:*?"<>|]/g, "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return (s || "no subject").slice(0, max).trim().replace(/[. ]+$/, "") || "no subject";
}

/** Resolve a relative directory inside ARCHIVE_ROOT, refusing anything that escapes it. */
export function resolveInside(root, relDir) {
  const rel = String(relDir ?? "").replace(/\\/g, "/").trim();
  if (!rel) throw new Error("relative folder is required");
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.startsWith("//")) throw new Error(`folder must be relative to ARCHIVE_ROOT: '${relDir}'`);
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) throw new Error(`folder may not contain '.' or '..': '${relDir}'`);
  if (parts.some((p) => ILLEGAL_NAME.test(p))) throw new Error(`folder name has an illegal character: '${relDir}'`);
  const full = resolve(root, ...parts);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!(full + sep).startsWith(rootWithSep)) throw new Error(`folder escapes ARCHIVE_ROOT: '${relDir}'`);
  return full;
}

async function uniqueName(dir, stem, ext) {
  let candidate = stem;
  for (let n = 2; n < 1000; n++) {
    if (!existsSync(join(dir, candidate + ext)) && !existsSync(join(dir, candidate))) return candidate + ext;
    candidate = `${stem} (${n})`;
  }
  throw new Error(`more than 999 files named '${stem}${ext}' in ${dir}`);
}

// ----------------------------------------------------------- idempotency

function dataDir() {
  if (process.env.AGENT_DATA_DIR) return process.env.AGENT_DATA_DIR;
  if (process.execPath && !/node(\.exe)?$/i.test(process.execPath) && !/bun(\.exe)?$/i.test(process.execPath)) return dirname(process.execPath);
  return process.cwd();
}
function loadStore() {
  const p = join(dataDir(), STORE_FILE);
  if (!existsSync(p)) return {};
  try { const j = JSON.parse(readFileSync(p, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
function saveStore(store) {
  const p = join(dataDir(), STORE_FILE);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 1), "utf8");
  renameSync(tmp, p);
}
const inflight = new Map();
async function once(key, work) {
  if (typeof key !== "string" || !key.trim()) throw new Error("idempotencyKey is required");
  const k = key.trim();
  const store = loadStore();
  if (store[k]) return { ...store[k], replayed: true };
  if (inflight.has(k)) return { ...(await inflight.get(k)), replayed: true };
  const p = (async () => {
    const result = await work();
    const s = loadStore();
    s[k] = { ...result, at: new Date().toISOString() };
    saveStore(s);
    return result;
  })();
  inflight.set(k, p);
  try { return await p; } finally { inflight.delete(k); }
}

// ------------------------------------------------------------- download

async function download(url, expectedSha, expectedBytes, fetchImpl = fetch) {
  if (!/^https:\/\//i.test(String(url ?? ""))) throw new Error("download url must be https");
  const ca = extraCa();
  const res = await fetchImpl(url, ca ? { tls: { ca } } : {});
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("downloaded file is empty");
  if (buf.length > MAX_BYTES) throw new Error(`file is larger than ${MAX_BYTES} bytes`);
  if (expectedBytes != null && Number(expectedBytes) !== buf.length) throw new Error(`size mismatch: expected ${expectedBytes}, got ${buf.length}`);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (expectedSha && String(expectedSha).toLowerCase() !== sha) throw new Error("sha256 mismatch — file changed in transit");
  return { buf, sha };
}

async function stampTimes(p, receivedAt) {
  if (!receivedAt) return;
  const t = new Date(receivedAt);
  if (!Number.isNaN(t.getTime())) { try { await utimes(p, t, t); } catch { /* not fatal */ } }
}

// ---------------------------------------------------------------- jobs

/**
 * file.save — write one archived email into a team folder.
 * payload: { idempotencyKey, relDir, stem, ext?=".eml", url, sha256, bytes?, receivedAt? }
 * result:  { relPath, fileName, bytes, sha256, root }
 */
export async function fileSave(payload = {}, deps = {}) {
  const root = archiveRoot();
  return once(payload.idempotencyKey, async () => {
    const ext = String(payload.ext ?? ".eml");
    if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) throw new Error(`bad extension '${ext}'`);
    const dir = resolveInside(root, payload.relDir);
    const { buf, sha } = await download(payload.url, payload.sha256, payload.bytes, deps.fetch);
    await mkdir(dir, { recursive: true });
    const name = await uniqueName(dir, cleanStem(payload.stem), ext);
    const finalPath = join(dir, name);
    const part = finalPath + ".part";
    await writeFile(part, buf, { flag: "wx" });
    const st = await stat(part);
    if (st.size !== buf.length) { await unlink(part).catch(() => {}); throw new Error("short write"); }
    await rename(part, finalPath);
    await stampTimes(finalPath, payload.receivedAt);
    return { relPath: relativeOf(root, finalPath), fileName: name, bytes: buf.length, sha256: sha };
  });
}

/**
 * file.move — move (Archive, Wrong team?) or copy (Also file to) an archived email.
 * payload: { idempotencyKey, fromRelPath, toRelDir, mode: "move"|"copy", receivedAt? }
 * result:  { relPath, fileName, bytes, sha256, mode, from }
 */
export async function fileMove(payload = {}) {
  const root = archiveRoot();
  return once(payload.idempotencyKey, async () => {
    const mode = payload.mode === "copy" ? "copy" : "move";
    const fromRel = String(payload.fromRelPath ?? "").replace(/\\/g, "/");
    const fromDir = resolveInside(root, dirname(fromRel) === "." ? "" : dirname(fromRel));
    const fromName = basename(fromRel);
    if (!fromName || ILLEGAL_NAME.test(fromName)) throw new Error(`bad source file name '${fromName}'`);
    const from = join(fromDir, fromName);
    if (!existsSync(from)) throw new Error(`source file not found: ${fromRel}`);
    const toDir = resolveInside(root, payload.toRelDir);
    await mkdir(toDir, { recursive: true });
    const ext = extname(fromName);
    const stem = fromName.slice(0, fromName.length - ext.length).replace(/ \(\d+\)$/, "");
    const name = await uniqueName(toDir, stem, ext);
    const to = join(toDir, name);
    const part = to + ".part";
    await copyFile(from, part);
    await rename(part, to);
    const buf = await readFile(to);
    if (buf.length === 0) throw new Error("zero-byte copy");
    await stampTimes(to, payload.receivedAt);
    if (mode === "move") await unlink(from);
    return { relPath: relativeOf(root, to), fileName: name, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), mode, from: fromRel };
  });
}

/**
 * archive.probe — can this agent reach and write ARCHIVE_ROOT? (Decision D4.)
 * Writes and deletes one small file in ARCHIVE_ROOT/.nelson-probe/. Lists top-level folders.
 */
export async function archiveProbe() {
  const out = { host: hostname(), user: safeUser(), root: null, exists: false, writable: false, folders: [], ledger: null, error: null };
  try {
    const root = archiveRoot();
    out.root = root;
    out.exists = existsSync(root);
    if (!out.exists) return out;
    out.folders = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().slice(0, 100);
    const probeDir = join(root, ".nelson-probe");
    await mkdir(probeDir, { recursive: true });
    const p = join(probeDir, `probe-${Date.now()}.txt`);
    await writeFile(p, `Nelson Order Mail write test from ${out.host}\n`, { flag: "wx" });
    await unlink(p);
    out.writable = true;
    const lp = join(root, ...LEDGER_REL.split("/"));
    if (existsSync(lp)) { const st = await stat(lp); out.ledger = { bytes: st.size, modified: st.mtime.toISOString() }; }
  } catch (e) {
    out.error = e?.message ?? String(e);
  }
  return out;
}

/**
 * archive.ledger.read — read the desktop app's processed.log (shadow comparison).
 * payload: { fromByte?: number, maxBytes?: number (≤ 1 MB) }
 * result:  { size, fromByte, toByte, text }  — read-only, fixed path.
 */
export async function archiveLedgerRead(payload = {}) {
  const root = archiveRoot();
  const p = join(root, ...LEDGER_REL.split("/"));
  if (!existsSync(p)) return { size: 0, fromByte: 0, toByte: 0, text: "", missing: true };
  const size = (await stat(p)).size;
  let from = Math.max(0, Math.trunc(Number(payload.fromByte ?? 0)) || 0);
  if (from > size) from = 0; // file was compacted: start again
  const max = Math.min(1024 * 1024, Math.max(16, Math.trunc(Number(payload.maxBytes ?? 512 * 1024)) || 512 * 1024));
  const len = Math.min(max, size - from);
  const fh = await open(p, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, from);
    // Only return whole lines.
    let text = buf.toString("utf8");
    let to = from + len;
    if (to < size) {
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) { text = text.slice(0, cut + 1); to = from + Buffer.byteLength(text, "utf8"); }
    }
    return { size, fromByte: from, toByte: to, text };
  } finally {
    await fh.close();
  }
}

function relativeOf(root, full) {
  return full.slice(root.length).replace(/^[\\/]+/, "").split(sep).join("/");
}
function safeUser() {
  try { return userInfo().username; } catch { return null; }
}
