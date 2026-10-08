// Run: node --test agent/handlers/__tests__/archive-files.test.js
// Offline: a temp folder stands in for ARCHIVE_ROOT; downloads use an injected fake fetch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let root, data;
before(() => {
  root = mkdtempSync(join(tmpdir(), "archroot-"));
  data = mkdtempSync(join(tmpdir(), "agentdata-"));
  process.env.ARCHIVE_ROOT = root;
  process.env.AGENT_DATA_DIR = data;
  globalThis.fetch = () => { throw new Error("network disabled in tests"); };
});
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); });

const mod = await import("../archive-files.js");
const body = Buffer.from("From: a@b.com\r\nSubject: PO 1\r\n\r\nhello");
const sha = createHash("sha256").update(body).digest("hex");
const fakeFetch = (buf = body, status = 200) => async () => new Response(buf, { status });

test("file.save writes into the team folder, never overwrites, stamps received time, replays on retry", async () => {
  const p = { idempotencyKey: "k1", relDir: "Team Texas & LA & MS", stem: "PO 1_20261008_090600", url: "https://x/y", sha256: sha, bytes: body.length, receivedAt: "2026-10-08T14:06:00Z" };
  const r1 = await mod.fileSave(p, { fetch: fakeFetch() });
  assert.equal(r1.relPath, "Team Texas & LA & MS/PO 1_20261008_090600.eml");
  assert.deepEqual(readFileSync(join(root, r1.relPath)), body);
  assert.equal(statSync(join(root, r1.relPath)).mtime.toISOString(), "2026-10-08T14:06:00.000Z");
  const again = await mod.fileSave(p, { fetch: fakeFetch() });
  assert.equal(again.replayed, true);
  assert.equal(readdirSync(join(root, "Team Texas & LA & MS")).length, 1);
  const r2 = await mod.fileSave({ ...p, idempotencyKey: "k2" }, { fetch: fakeFetch() });
  assert.equal(r2.fileName, "PO 1_20261008_090600 (2).eml");
  assert.equal(readdirSync(join(root, "Team Texas & LA & MS")).filter((f) => f.endsWith(".part")).length, 0);
});

test("file.save refuses paths outside ARCHIVE_ROOT and bad downloads", async () => {
  for (const relDir of ["../escape", "C:/Windows", "//server/share", "/etc", "a/../../b", "", "Team:Bad"]) {
    await assert.rejects(mod.fileSave({ idempotencyKey: `bad-${relDir}`, relDir, stem: "x", url: "https://x", sha256: sha }, { fetch: fakeFetch() }));
  }
  await assert.rejects(mod.fileSave({ idempotencyKey: "sha", relDir: "E2G", stem: "x", url: "https://x", sha256: "0".repeat(64) }, { fetch: fakeFetch() }), /sha256 mismatch/);
  await assert.rejects(mod.fileSave({ idempotencyKey: "http", relDir: "E2G", stem: "x", url: "http://x", sha256: sha }, { fetch: fakeFetch() }), /https/);
  await assert.rejects(mod.fileSave({ idempotencyKey: "404", relDir: "E2G", stem: "x", url: "https://x", sha256: sha }, { fetch: fakeFetch(body, 404) }), /404/);
  await assert.rejects(mod.fileSave({ idempotencyKey: "", relDir: "E2G", stem: "x", url: "https://x" }, { fetch: fakeFetch() }), /idempotencyKey/);
  assert.equal(existsSync(join(root, "..", "escape")), false);
  assert.equal(existsSync(join(root, "E2G")), false, "a failed save must not leave a folder or file behind");
});

test("stems are cleaned like the desktop and capped", () => {
  assert.equal(mod.cleanStem('Damaged Item/Order #1393084: "x" <y>|z?*'), "Damaged ItemOrder #1393084 x yz");
  assert.equal(mod.cleanStem(""), "no subject");
  assert.equal(mod.cleanStem("a".repeat(300)).length, 180);
});

test("file.move moves (Archive / Wrong team?) and copies (Also file to) without overwriting", async () => {
  mkdirSync(join(root, "#E2G"), { recursive: true });
  writeFileSync(join(root, "#E2G", "Order 5_20261008_100000.eml"), body);
  const c = await mod.fileMove({ idempotencyKey: "m1", fromRelPath: "#E2G/Order 5_20261008_100000.eml", toRelDir: "Mid West & AL Pan", mode: "copy" });
  assert.equal(c.relPath, "Mid West & AL Pan/Order 5_20261008_100000.eml");
  assert.ok(existsSync(join(root, "#E2G", "Order 5_20261008_100000.eml")), "copy keeps the source");
  const m = await mod.fileMove({ idempotencyKey: "m2", fromRelPath: "#E2G/Order 5_20261008_100000.eml", toRelDir: "Mid West & AL Pan", mode: "move" });
  assert.equal(m.fileName, "Order 5_20261008_100000 (2).eml");
  assert.equal(existsSync(join(root, "#E2G", "Order 5_20261008_100000.eml")), false, "move removes the source");
  const replay = await mod.fileMove({ idempotencyKey: "m2", fromRelPath: "#E2G/Order 5_20261008_100000.eml", toRelDir: "Mid West & AL Pan", mode: "move" });
  assert.equal(replay.replayed, true);
  await assert.rejects(mod.fileMove({ idempotencyKey: "m3", fromRelPath: "../x.eml", toRelDir: "Ignored" }));
  await assert.rejects(mod.fileMove({ idempotencyKey: "m4", fromRelPath: "#E2G/missing.eml", toRelDir: "Ignored" }), /not found/);
});

test("archive.probe reports reachability and leaves nothing behind", async () => {
  const r = await mod.archiveProbe();
  assert.equal(r.exists, true);
  assert.equal(r.writable, true);
  assert.ok(r.folders.includes("Mid West & AL Pan"));
  assert.deepEqual(readdirSync(join(root, ".nelson-probe")), []);
});

test("archive.ledger.read returns whole lines from an offset and restarts after compaction", async () => {
  mkdirSync(join(root, ".archiver"), { recursive: true });
  const lines = "# header\n2026-10-08T09:00:00\tmid:<a@x>\tE1\tS1\tTeam Texas & LA & MS\tPC\tu\r\n2026-10-08T09:01:00\tmid:<b@x>\tE2\tS2\tIgnored\tPC\tu\r\n";
  writeFileSync(join(root, ".archiver", "processed.log"), lines);
  const r = await mod.archiveLedgerRead({ fromByte: 0, maxBytes: 60 });
  assert.equal(r.text.endsWith("\n"), true);
  assert.ok(r.toByte < r.size);
  const rest = await mod.archiveLedgerRead({ fromByte: r.toByte });
  assert.equal(r.text + rest.text, lines);
  const restart = await mod.archiveLedgerRead({ fromByte: 999999 });
  assert.equal(restart.fromByte, 0);
});
