// Live pull of NDI's "Primary Truck Capacity.xlsx" from SharePoint into
// truck_capacity_runs. PULL ONLY — nothing in this file ever writes to Graph.
//
// Auth goes through the Lovable connector gateway (delegated OAuth, the operator
// signs in with his NDI Microsoft account). No client secrets live in code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  parseTruckCapacityWorkbook,
  normalizeSheetName,
  type ParsedRow,
  type ParseResult,
  type SheetMap,
} from "./workbook-parse";

/* ------------------------------- configuration ------------------------------ */

export type WorkbookSyncSettings = {
  /** SharePoint drive (library "Truck Capacity Reports"). */
  driveId: string;
  /** "Primary Truck Capacity.xlsx". */
  itemId: string;
  enabled: boolean;
};

export const DEFAULT_WORKBOOK_SYNC_SETTINGS: WorkbookSyncSettings = {
  // Verified 2026-09-10 against ndiof.sharepoint.com/sites/WarehouseManagementTeam.
  driveId: "b!bcVP0fOkwEKS-reRrnRy6UkfbmvjUddHsyzNpVGRKBaSAllSxKblR7_exliQ-BbN",
  itemId: "01X2CTIV3QYP2XXPVDI5BYOPTCVAYA53SN",
  enabled: true,
};

export async function getWorkbookSyncSettings(): Promise<WorkbookSyncSettings> {
  const { data } = await supabaseAdmin
    .from("app_settings").select("value").eq("key", "truck_capacity_workbook_sync").maybeSingle();
  return { ...DEFAULT_WORKBOOK_SYNC_SETTINGS, ...((data?.value ?? {}) as Partial<WorkbookSyncSettings>) };
}

/* ------------------------------ connector access ---------------------------- */

const GATEWAY = "https://connector-gateway.lovable.dev";

type Connector = { id: "microsoft_sharepoint" | "microsoft_onedrive"; key: string };

/**
 * The SharePoint connector is preferred; OneDrive is the documented fallback
 * because both proxy the same Microsoft Graph v1.0 surface, so the identical
 * /drives/{driveId}/items/{itemId} call works through either.
 */
export function resolveConnector(): Connector | null {
  const sp = process.env["MICROSOFT_SHAREPOINT_API_KEY"];
  if (sp) return { id: "microsoft_sharepoint", key: sp };
  const od = process.env["MICROSOFT_ONEDRIVE_API_KEY"];
  if (od) return { id: "microsoft_onedrive", key: od };
  return null;
}

export function connectorStatus(): { connected: boolean; connector: string | null; lovableKey: boolean } {
  const c = resolveConnector();
  return {
    connected: !!c && !!process.env["LOVABLE_API_KEY"],
    connector: c?.id ?? null,
    lovableKey: !!process.env["LOVABLE_API_KEY"],
  };
}

async function graph(path: string, accept: "json" | "binary"): Promise<Response> {
  const connector = resolveConnector();
  if (!connector) {
    throw new Error(
      "No Microsoft connector is linked to this project yet — link the Microsoft SharePoint connector, then run Sync now. Until then use Upload workbook.",
    );
  }
  const lovableKey = process.env["LOVABLE_API_KEY"];
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is missing from the server environment.");

  const res = await fetch(`${GATEWAY}/${connector.id}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": connector.key,
      ...(accept === "json" ? { Accept: "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`SharePoint gateway request failed [${res.status}] ${path}: ${body}`);
    throw new Error(`Microsoft Graph request failed [${res.status}]: ${body}`);
  }
  return res;
}

export type WorkbookMeta = { eTag: string | null; lastModifiedDateTime: string | null; size: number | null; name: string | null };

export async function fetchWorkbookMeta(s: WorkbookSyncSettings): Promise<WorkbookMeta> {
  const res = await graph(`/drives/${s.driveId}/items/${s.itemId}`, "json");
  const j: any = await res.json();
  return {
    eTag: j?.eTag ?? j?.cTag ?? null,
    lastModifiedDateTime: j?.lastModifiedDateTime ?? null,
    size: typeof j?.size === "number" ? j.size : null,
    name: j?.name ?? null,
  };
}

export async function downloadWorkbook(s: WorkbookSyncSettings): Promise<Buffer> {
  const res = await graph(`/drives/${s.driveId}/items/${s.itemId}/content`, "binary");
  return Buffer.from(await res.arrayBuffer());
}

/* --------------------------------- sheet map -------------------------------- */

export async function loadSheetMap(): Promise<SheetMap> {
  const { data, error } = await supabaseAdmin
    .from("truck_capacity_sheet_map")
    .select("sheet_name, route_id, active")
    .limit(2000);
  if (error) throw new Error(error.message);
  const map: SheetMap = new Map();
  for (const row of data ?? []) {
    map.set(normalizeSheetName(row.sheet_name), { route_id: row.route_id ?? null, active: !!row.active });
  }
  return map;
}

/* ---------------------------------- upsert ---------------------------------- */

const DIFF_FIELDS = [
  "capacity_frac",
  "vendor_pickup_frac",
  "driver",
  "pallet_count",
  "returned_pallets",
  "notes",
] as const;

type ExistingRow = {
  id: string;
  route_id: string;
  run_date: string;
  run_seq: number;
  capacity_frac: number | null;
  vendor_pickup_frac: number | null;
  driver: string | null;
  pallet_count: number | null;
  returned_pallets: number | null;
  notes: string | null;
  source: string;
  prior_values: any;
  missing_from_sheet: boolean | null;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
  }
  return String(a) === String(b);
}

export type UpsertCounts = {
  inserted: number;
  updated: number;
  unchanged: number;
  missing_marked: number;
  duplicate_keys: Array<{ route_id: string; run_date: string; run_seq: number }>;
};

/**
 * Upsert on (route_id, run_date, run_seq). Never deletes: rows that disappeared
 * from a sheet are flagged missing_from_sheet instead. Only rows this sync owns
 * (source='sharepoint') get flagged, so Joe's original 'import' history is never
 * relabelled as missing.
 */
export async function applyWorkbookRows(rows: ParsedRow[]): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0, missing_marked: 0, duplicate_keys: [] };

  // Dedupe within the payload; Postgres refuses to touch a conflict target twice.
  const byKey = new Map<string, ParsedRow>();
  for (const r of rows) {
    const key = `${r.route_id}|${r.run_date}|${r.run_seq}`;
    if (byKey.has(key)) counts.duplicate_keys.push({ route_id: r.route_id, run_date: r.run_date, run_seq: r.run_seq });
    byKey.set(key, r);
  }
  const deduped = Array.from(byKey.values());
  if (deduped.length === 0) return counts;

  const routeIds = Array.from(new Set(deduped.map((r) => r.route_id)));

  // Existing rows for the affected routes, paginated past the 1,000-row cap.
  const existing = new Map<string, ExistingRow>();
  for (const routeId of routeIds) {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabaseAdmin
        .from("truck_capacity_runs")
        .select("id, route_id, run_date, run_seq, capacity_frac, vendor_pickup_frac, driver, pallet_count, returned_pallets, notes, source, prior_values, missing_from_sheet")
        .eq("route_id", routeId)
        .order("run_date", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as ExistingRow[]) {
        existing.set(`${row.route_id}|${row.run_date}|${row.run_seq}`, row);
      }
      if (!data || data.length < pageSize) break;
    }
  }

  const inserts: any[] = [];
  const updates: any[] = [];
  const nowIso = new Date().toISOString();

  for (const r of deduped) {
    const key = `${r.route_id}|${r.run_date}|${r.run_seq}`;
    const prev = existing.get(key);
    if (!prev) {
      inserts.push({
        route_id: r.route_id,
        run_date: r.run_date,
        run_seq: r.run_seq,
        capacity_frac: r.capacity_frac,
        vendor_pickup_frac: r.vendor_pickup_frac,
        driver: r.driver,
        pallet_count: r.pallet_count,
        returned_pallets: r.returned_pallets,
        notes: r.notes,
        source: "sharepoint",
        entered_by: null,
        missing_from_sheet: false,
      });
      continue;
    }
    const changed: Record<string, unknown> = {};
    for (const f of DIFF_FIELDS) {
      if (!sameValue((prev as any)[f], (r as any)[f])) changed[f] = (prev as any)[f];
    }
    const needsSource = prev.source !== "sharepoint";
    const needsUnflag = prev.missing_from_sheet === true;
    if (Object.keys(changed).length === 0 && !needsSource && !needsUnflag) {
      counts.unchanged += 1;
      continue;
    }
    const history = Array.isArray(prev.prior_values) ? prev.prior_values : prev.prior_values ? [prev.prior_values] : [];
    updates.push({
      id: prev.id,
      route_id: r.route_id,
      run_date: r.run_date,
      run_seq: r.run_seq,
      capacity_frac: r.capacity_frac,
      vendor_pickup_frac: r.vendor_pickup_frac,
      driver: r.driver,
      pallet_count: r.pallet_count,
      returned_pallets: r.returned_pallets,
      notes: r.notes,
      source: "sharepoint",
      missing_from_sheet: false,
      updated_at: nowIso,
      prior_values: Object.keys(changed).length
        ? [...history, { at: nowIso, from_source: prev.source, changed }].slice(-25)
        : history.length ? history : null,
    });
  }

  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("truck_capacity_runs").insert(batch);
    if (error) throw new Error(`Insert failed: ${error.message}`);
    counts.inserted += batch.length;
  }
  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("truck_capacity_runs").upsert(batch, { onConflict: "id" });
    if (error) throw new Error(`Update failed: ${error.message}`);
    counts.updated += batch.length;
  }

  // Rows previously pulled from the sheet that are gone now, inside the date
  // range the sheet still covers. Flag, never delete.
  const seen = new Set(byKey.keys());
  const missingIds: string[] = [];
  const minDate = deduped.reduce((m, r) => (r.run_date < m ? r.run_date : m), deduped[0].run_date);
  const maxDate = deduped.reduce((m, r) => (r.run_date > m ? r.run_date : m), deduped[0].run_date);
  for (const [key, row] of existing) {
    if (seen.has(key)) continue;
    if (row.source !== "sharepoint") continue;
    if (row.run_date < minDate || row.run_date > maxDate) continue;
    if (row.missing_from_sheet) continue;
    missingIds.push(row.id);
  }
  for (let i = 0; i < missingIds.length; i += 500) {
    const batch = missingIds.slice(i, i + 500);
    const { error } = await supabaseAdmin
      .from("truck_capacity_runs").update({ missing_from_sheet: true, updated_at: nowIso }).in("id", batch);
    if (error) throw new Error(`Missing-flag update failed: ${error.message}`);
    counts.missing_marked += batch.length;
  }

  return counts;
}

/* ----------------------------------- run ------------------------------------ */

export type SyncOutcome = {
  ok: boolean;
  logId: string | null;
  status: "success" | "skipped_unchanged" | "error" | "no_connector";
  reason?: string;
  fileModifiedAt?: string | null;
  eTag?: string | null;
  sheetsSeen?: number;
  counts?: UpsertCounts;
  perSheet?: Array<{ sheet: string; route_id: string | null; status: string; rows: number; no_run_rows: number; rejected_capacity: number; skipped_no_date: number }>;
  unmatchedSheets?: string[];
  warnings?: string[];
  error?: string;
};

export async function runWorkbookSync(opts: {
  source: "sharepoint" | "upload" | "cron";
  fileBase64?: string;
  force?: boolean;
  triggeredBy?: string | null;
}): Promise<SyncOutcome> {
  const settings = await getWorkbookSyncSettings();
  const isUpload = opts.source === "upload";
  const logSource = isUpload ? "upload" : "sharepoint";

  if (!isUpload && !settings.enabled && !opts.force) {
    return { ok: true, logId: null, status: "skipped_unchanged", reason: "sync_disabled" };
  }

  let meta: WorkbookMeta | null = null;
  if (!isUpload) {
    const status = connectorStatus();
    if (!status.connected) {
      return {
        ok: false, logId: null, status: "no_connector",
        reason: "The Microsoft SharePoint connector is not linked to this project yet.",
      };
    }
    meta = await fetchWorkbookMeta(settings);
    if (!opts.force) {
      const { data: state } = await supabaseAdmin
        .from("truck_capacity_sync_state").select("etag, file_modified_at").eq("id", true).maybeSingle();
      const sameEtag = !!state?.etag && !!meta.eTag && state.etag === meta.eTag;
      const sameMtime =
        !!state?.file_modified_at && !!meta.lastModifiedDateTime &&
        Date.parse(state.file_modified_at) === Date.parse(meta.lastModifiedDateTime);
      if (sameEtag || (sameMtime && !meta.eTag)) {
        await supabaseAdmin.from("truck_capacity_sync_state")
          .update({ last_synced_at: new Date().toISOString(), last_status: "skipped_unchanged", updated_at: new Date().toISOString() })
          .eq("id", true);
        return { ok: true, logId: null, status: "skipped_unchanged", reason: "workbook_unchanged", fileModifiedAt: meta.lastModifiedDateTime, eTag: meta.eTag };
      }
    }
  }

  const { data: logRow } = await supabaseAdmin
    .from("truck_capacity_sync_log")
    .insert({
      source: logSource,
      status: "running",
      file_modified_at: meta?.lastModifiedDateTime ?? null,
      file_etag: meta?.eTag ?? null,
      triggered_by: opts.triggeredBy ?? null,
    })
    .select("id").single();
  const logId: string | null = logRow?.id ?? null;

  try {
    const buffer = isUpload
      ? Buffer.from(opts.fileBase64 ?? "", "base64")
      : await downloadWorkbook(settings);
    if (buffer.length === 0) throw new Error("Workbook download was empty.");

    const sheetMap = await loadSheetMap();
    const parsed: ParseResult = await parseTruckCapacityWorkbook(buffer, sheetMap);
    const counts = await applyWorkbookRows(parsed.rows);

    const perSheet = parsed.sheets.map((s) => ({
      sheet: s.sheet, route_id: s.route_id, status: s.status,
      rows: s.rows, no_run_rows: s.no_run_rows,
      rejected_capacity: s.rejected_capacity, skipped_no_date: s.skipped_no_date,
    }));
    const skipped = parsed.sheets.reduce((n, s) => n + s.skipped_no_date + s.rejected_capacity, 0);

    if (logId) {
      await supabaseAdmin.from("truck_capacity_sync_log").update({
        finished_at: new Date().toISOString(),
        status: "success",
        sheets_seen: parsed.sheets.length,
        rows_inserted: counts.inserted,
        rows_updated: counts.updated,
        rows_skipped: skipped,
        rows_missing: counts.missing_marked,
        unmatched_sheets: parsed.unmatchedSheets,
        errors: [...parsed.warnings, ...counts.duplicate_keys.map((d) => `duplicate key ${d.run_date}#${d.run_seq}`)],
      }).eq("id", logId);
    }
    if (!isUpload) {
      await supabaseAdmin.from("truck_capacity_sync_state").upsert({
        id: true,
        etag: meta?.eTag ?? null,
        file_modified_at: meta?.lastModifiedDateTime ?? null,
        last_synced_at: new Date().toISOString(),
        last_status: "success",
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });
    }

    return {
      ok: true, logId, status: "success",
      fileModifiedAt: meta?.lastModifiedDateTime ?? null, eTag: meta?.eTag ?? null,
      sheetsSeen: parsed.sheets.length, counts, perSheet,
      unmatchedSheets: parsed.unmatchedSheets, warnings: parsed.warnings,
    };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (logId) {
      await supabaseAdmin.from("truck_capacity_sync_log").update({
        finished_at: new Date().toISOString(), status: "error", errors: [message],
      }).eq("id", logId);
    }
    if (!isUpload) {
      await supabaseAdmin.from("truck_capacity_sync_state")
        .update({ last_synced_at: new Date().toISOString(), last_status: "error", updated_at: new Date().toISOString() })
        .eq("id", true);
    }
    return { ok: false, logId, status: "error", error: message };
  }
}
