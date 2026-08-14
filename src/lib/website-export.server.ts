// Charlston Office Furniture website export → partner SFTP (server-only).
//
// The app runs on Cloudflare Workers: no SSH/SFTP, no route to NDI's SQL
// Server. Both halves of this job therefore run in the on-prem bridge agent
// (job kind `website.export.sftp`). This module owns configuration, filename
// resolution, run bookkeeping, and turning agent failures into run rows
// instead of crashes.
//
// Source SQL being automated:
//     USE P21_Analytics_PLAY
//     EXEC Website.usp_ExportSuiteCommerceTest;
//     GO
// `USE` becomes the connection database, `GO` is a client batch separator.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";

const db = () => supabaseAdmin as any;

export type WebsiteExportSettings = {
  enabled: boolean;
  database: string;
  procedure: string;
  /** `%Y`/`%m`/`%d` tokens; anything else is literal. */
  filenamePattern: string;
  remoteFolder: string;
  delimiter: string;
  header: boolean;
  /** IANA zone used to resolve the date tokens in the filename. */
  timezone: string;
  /** UTC hour the nightly cron block fires (0–23). */
  cronHourUtc: number;
};

export const DEFAULT_WEBSITE_EXPORT_SETTINGS: WebsiteExportSettings = {
  enabled: false,
  database: "P21_Analytics_PLAY",
  procedure: "Website.usp_ExportSuiteCommerceTest",
  filenamePattern: "NDI_%Y%m%d.csv",
  remoteFolder: "files.ndiofficefurniture.net/Charlston_OF",
  delimiter: ",",
  header: true,
  timezone: "America/Chicago",
  cronHourUtc: 9,
};

export async function getWebsiteExportSettings(): Promise<WebsiteExportSettings> {
  const { data } = await db().from("app_settings").select("value").eq("key", "website_export").maybeSingle();
  return { ...DEFAULT_WEBSITE_EXPORT_SETTINGS, ...((data?.value ?? {}) as Partial<WebsiteExportSettings>) };
}

export async function saveWebsiteExportSettings(
  patch: Partial<WebsiteExportSettings>,
): Promise<WebsiteExportSettings> {
  const next = { ...(await getWebsiteExportSettings()), ...patch };
  const { error } = await db()
    .from("app_settings")
    .upsert({ key: "website_export", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
  return next;
}

/** Calendar parts of `at` in `timezone` (no external deps, Workers-safe). */
function zonedParts(at: Date, timezone: string): { y: string; m: string; d: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { y: parts.year!, m: parts.month!, d: parts.day! };
}

export function resolveFilename(pattern: string, at: Date, timezone: string): string {
  const { y, m, d } = zonedParts(at, timezone);
  return String(pattern)
    .replace(/%Y/g, y)
    .replace(/%m/g, m)
    .replace(/%d/g, d);
}

export type WebsiteExportRunResult = {
  ok: boolean;
  runId: string;
  status: "done" | "error";
  dryRun: boolean;
  filename: string;
  remotePath?: string | null;
  rowCount?: number | null;
  byteSize?: number | null;
  columns?: string[] | null;
  preview?: string[] | null;
  error?: string | null;
};

export async function runWebsiteExport(opts: {
  trigger: "manual" | "cron";
  dryRun?: boolean;
  triggeredBy?: string | null;
  now?: Date;
  timeoutMs?: number;
}): Promise<WebsiteExportRunResult> {
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? new Date();
  const s = await getWebsiteExportSettings();
  const filename = resolveFilename(s.filenamePattern, now, s.timezone);

  const { data: run, error: insErr } = await db()
    .from("web_export_runs")
    .insert({
      trigger: opts.trigger,
      dry_run: dryRun,
      status: "running",
      database_name: s.database,
      procedure_name: s.procedure,
      remote_folder: s.remoteFolder,
      remote_filename: filename,
      triggered_by: opts.triggeredBy ?? null,
    })
    .select("id")
    .single();
  if (insErr || !run) throw new Error(insErr?.message ?? "Could not create export run");
  const runId = run.id as string;

  const finish = async (patch: Record<string, unknown>) => {
    await db().from("web_export_runs").update({ finished_at: new Date().toISOString(), ...patch }).eq("id", runId);
  };

  try {
    const { jobId, result } = await runJob(
      "website.export.sftp",
      {
        database: s.database,
        procedure: s.procedure,
        filename,
        remoteFolder: s.remoteFolder,
        delimiter: s.delimiter,
        header: s.header,
        dryRun,
        previewRows: 3,
      },
      opts.timeoutMs ?? 600000,
    );
    const r = (result ?? {}) as any;
    const columns: string[] = Array.isArray(r.columns) ? r.columns : [];
    const preview: string[] = Array.isArray(r.preview) ? r.preview : [];
    await finish({
      status: "done",
      job_id: jobId,
      row_count: Number.isFinite(r.rowCount) ? r.rowCount : null,
      byte_size: Number.isFinite(r.byteSize) ? r.byteSize : null,
      columns,
      preview,
      remote_filename: r.filename ?? filename,
      error: null,
    });
    return {
      ok: true,
      runId,
      status: "done",
      dryRun,
      filename: r.filename ?? filename,
      remotePath: r.remotePath ?? null,
      rowCount: r.rowCount ?? null,
      byteSize: r.byteSize ?? null,
      columns,
      preview,
      error: null,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await finish({ status: "error", error: msg });
    return { ok: false, runId, status: "error", dryRun, filename, error: msg };
  }
}
