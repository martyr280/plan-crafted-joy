// website.export.sftp — Charlston Office Furniture website data export.
//
// Two jobs in one handler, because both halves must run on-prem:
//   1. Execute a stored procedure in the analytics database and take its
//      result set (this is NOT a SELECT, so the sql.select handler can't
//      be used — it rejects anything not starting with SELECT/WITH/DECLARE).
//   2. Render the rows as CSV and drop the file on the partner's SFTP server
//      over SSH key auth, writing to a temp name and renaming into place so
//      the partner never reads a half-written file.
//
// SFTP credentials come from this machine's .env — never from the payload and
// never from the cloud app. The private key never leaves this server.
//
// Source SQL this replaces (run manually in SSMS):
//     USE P21_Analytics_PLAY
//     EXEC Website.usp_ExportSuiteCommerceTest;
//     GO
// `USE` becomes the connection's database; `GO` is a client batch separator
// and is not sent to SQL Server.

import sql from "mssql";
import fs from "node:fs/promises";
// Static imports so `bun build --compile` definitely bundles them into the .exe.
import SftpClient from "ssh2-sftp-client";
import { renderCsv } from "./csv.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_$#]*$/;

function assertDatabase(name) {
  if (!IDENT.test(String(name ?? ""))) {
    throw new Error(`Invalid database name: ${JSON.stringify(name)}`);
  }
}

/** `schema.proc` or `proc` — no arguments, no semicolons, no batch tricks. */
function assertProcedure(name) {
  const parts = String(name ?? "").split(".");
  if (parts.length < 1 || parts.length > 2 || !parts.every((p) => IDENT.test(p))) {
    throw new Error(`Invalid procedure name: ${JSON.stringify(name)}`);
  }
  return parts.map((p) => `[${p}]`).join(".");
}

/** Dedicated connection — the shared pool is bound to the P21 database. */
async function connectTo(database) {
  return sql.connect({
    server: process.env.P21_SQL_HOST,
    port: Number(process.env.P21_SQL_PORT ?? 1433),
    database,
    user: process.env.P21_SQL_USER,
    password: process.env.P21_SQL_PASS,
    options: {
      encrypt: process.env.P21_SQL_ENCRYPT !== "false",
      trustServerCertificate: process.env.P21_SQL_TRUST_CERT !== "false",
    },
    requestTimeout: Number(process.env.WEBSITE_EXPORT_SQL_TIMEOUT_MS ?? 600000),
    pool: { min: 0, max: 1, idleTimeoutMillis: 5000 },
  });
}

/** Last recordset carrying column metadata — matches SSMS "final grid". */
function chooseRecordset(result) {
  const sets = Array.isArray(result.recordsets) ? result.recordsets : [];
  for (let i = sets.length - 1; i >= 0; i--) {
    if (sets[i] && sets[i].columns && Object.keys(sets[i].columns).length) return sets[i];
  }
  for (let i = sets.length - 1; i >= 0; i--) {
    if (sets[i] && sets[i].length) return sets[i];
  }
  return result.recordset ?? [];
}

async function upload(csvText, remoteFolder, filename) {
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
    throw new Error(
      `SFTP delivery is not configured on this agent — missing ${missing.join(", ")} in .env. ` +
        `Add them (and the ${"NDI-Charlston-Automation"} private key file) and restart the agent service.`,
    );
  }

  let privateKey;
  try {
    privateKey = await fs.readFile(keyPath);
  } catch (e) {
    throw new Error(`Cannot read SSH private key at ${keyPath}: ${e?.message ?? e}`);
  }

  const client = new SftpClient();
  const folder = String(remoteFolder ?? "").replace(/\/+$/, "");
  const finalPath = folder ? `${folder}/${filename}` : filename;
  const tempPath = `${finalPath}.part`;
  try {
    await client.connect({ host, port, username, privateKey, passphrase, readyTimeout: 30000 });
    await client.put(Buffer.from(csvText, "utf8"), tempPath);
    // Rename into place. Some servers refuse rename onto an existing name.
    try {
      await client.rename(tempPath, finalPath);
    } catch {
      try { await client.delete(finalPath); } catch { /* not there */ }
      await client.rename(tempPath, finalPath);
    }
    return { remotePath: finalPath };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

// payload: { database, procedure, filename, remoteFolder, delimiter?, header?,
//            dryRun?, previewRows? }
export async function websiteExportSftp(payload = {}) {
  const {
    database,
    procedure,
    filename,
    remoteFolder,
    delimiter = ",",
    header = true,
    dryRun = false,
    previewRows = 3,
  } = payload;

  assertDatabase(database);
  const proc = assertProcedure(procedure);
  if (!filename || /[\\/]/.test(String(filename))) {
    throw new Error(`Invalid filename: ${JSON.stringify(filename)}`);
  }

  let pool;
  let recordset;
  try {
    pool = await connectTo(database);
    const result = await pool.request().query(`EXEC ${proc}`);
    recordset = chooseRecordset(result);
  } finally {
    if (pool) { try { await pool.close(); } catch { /* ignore */ } }
  }

  const columns = recordset?.columns
    ? Object.keys(recordset.columns)
    : (recordset?.[0] ? Object.keys(recordset[0]) : []);
  const types = {};
  if (recordset?.columns) {
    for (const [name, meta] of Object.entries(recordset.columns)) {
      types[name] = meta?.type?.declaration ?? meta?.type?.name ?? null;
    }
  }
  const rows = Array.isArray(recordset) ? recordset : [];
  if (columns.length === 0) {
    throw new Error(
      `${procedure} returned no result set with column metadata — nothing to export.`,
    );
  }

  const csvText = renderCsv(rows, columns, { delimiter, header, types });
  const byteSize = Buffer.byteLength(csvText, "utf8");
  const previewLines = csvText.split("\r\n").slice(0, Math.max(1, Number(previewRows) + (header ? 1 : 0)));

  const base = {
    database,
    procedure,
    columns,
    rowCount: rows.length,
    byteSize,
    filename,
    remoteFolder,
    preview: previewLines,
  };

  if (dryRun) return { ...base, dryRun: true, delivered: false };

  const { remotePath } = await upload(csvText, remoteFolder, filename);
  return { ...base, dryRun: false, delivered: true, remotePath };
}
