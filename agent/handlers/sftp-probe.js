// sftp.probe — read-only diagnostics for the partner SFTP delivery.
//
// Answers the only question that matters when the app says "delivered" and the
// partner says "we don't see it": which absolute directory does the login land
// in, what is actually sitting there, and does the folder the partner names
// exist at all. Never writes, never deletes, never returns file contents.

import fs from "node:fs/promises";
import SftpClient from "ssh2-sftp-client";

function creds() {
  const host = process.env.SFTP_HOST;
  const port = Number(process.env.SFTP_PORT ?? 22);
  const username = process.env.SFTP_USERNAME;
  const keyPath = process.env.SFTP_PRIVATE_KEY_PATH;
  const passphrase = process.env.SFTP_PRIVATE_KEY_PASSPHRASE || undefined;
  const missing = [];
  if (!host) missing.push("SFTP_HOST");
  if (!username) missing.push("SFTP_USERNAME");
  if (!keyPath) missing.push("SFTP_PRIVATE_KEY_PATH");
  if (missing.length) {
    throw new Error(`SFTP is not configured on this agent — missing ${missing.join(", ")} in .env.`);
  }
  return { host, port, username, keyPath, passphrase };
}

function entry(e) {
  return {
    name: e.name,
    type: e.type, // '-' file, 'd' dir, 'l' link
    size: e.size,
    modifyTime: e.modifyTime ? new Date(e.modifyTime).toISOString() : null,
  };
}

// payload: { paths?: string[] }  — extra directories to inspect
export async function sftpProbe(payload = {}) {
  const { host, port, username, keyPath, passphrase } = creds();
  const privateKey = await fs.readFile(keyPath);
  const client = new SftpClient();
  const out = { host, port, username, cwd: null, listings: {}, errors: {} };
  try {
    await client.connect({ host, port, username, privateKey, passphrase, readyTimeout: 30000 });
    try {
      out.cwd = await client.realPath(".");
    } catch (e) {
      out.errors["realPath(.)"] = e?.message ?? String(e);
    }

    const targets = ["."];
    for (const p of Array.isArray(payload.paths) ? payload.paths : []) {
      const t = String(p ?? "").trim();
      if (t && !targets.includes(t)) targets.push(t);
    }

    for (const t of targets) {
      try {
        const abs = await client.realPath(t).catch(() => t);
        const list = await client.list(t);
        out.listings[t] = {
          absolutePath: abs,
          count: list.length,
          // Newest first — the delivered file should be at the top.
          entries: list
            .map(entry)
            .sort((a, b) => String(b.modifyTime ?? "").localeCompare(String(a.modifyTime ?? "")))
            .slice(0, 40),
        };
      } catch (e) {
        out.errors[t] = e?.message ?? String(e);
      }
    }
    return out;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}
