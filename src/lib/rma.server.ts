// RMA Analytics :: server-only pipeline.
//
// Mirrors the Truck Capacity P21 overlay pattern deliberately:
//   editable SQL (app_settings) -> validateSelectSql (SELECT/WITH only)
//   -> textual output-contract check -> bridge runJob("sql.select")
//   -> runtime output-shape check -> rma_snapshot_rows -> rma_entity_monthly.
//
// The exact P21 RMA schema is NOT verified against NDI's install yet, which is
// why the query is admin-editable and every failure is recorded on the
// snapshot row + activity_events instead of throwing.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import { validateSelectSql, stripLeadingSqlComments } from "./sql-schedules.server";
import {
  validateRmaSqlText,
  validateRmaSqlOutput,
  REQUIRED_COLUMNS,
  OPTIONAL_COLUMNS,
  type SqlValidation,
} from "./rma/sql-validate";
import { bucketReason } from "./rma/reasons";
import {
  entityMonthlyAggregates,
  monthKey,
  num,
  type RmaRow,
} from "./rma/attribution";

export { validateRmaSqlText, validateRmaSqlOutput };
export type { SqlValidation };

export const RMA_SQL_SETTING_KEY = "rma_snapshot_sql";

/**
 * Default RMA extract. UNVERIFIED against NDI's P21 install — Kevin (NDI P21
 * admin) must confirm table + column names before production use, exactly as
 * we did for the truck-capacity demand query.
 *
 * Written against the most common P21 shape: returns live on oe_hdr/oe_line
 * with a negative-quantity / RMA class marker, reason codes on oe_line
 * (`return_reason` or similar) resolved through a reason lookup table. Where
 * the install has dedicated rma_hdr/rma_line tables, swap the FROM/JOINs and
 * keep the output aliases identical.
 */
export const DEFAULT_RMA_SQL = `-- RMA Analytics :: return / RMA line extract.
--
-- ⚠️ UNVERIFIED SCHEMA. NDI's P21 admin must confirm these table/column names
-- against the live install before this is trusted in production. Only the
-- OUTPUT ALIASES below are contractual — rewrite the FROM/JOIN freely.
--
-- Required output columns (exact names):
--   rma_no        text     -- RMA / return document number
--   rma_date      date     -- date the return was entered
--   qty           numeric  -- returned quantity (positive)
--   value         numeric  -- extended credit value (positive)
--   reason_code   text     -- P21 reason code as entered
-- Optional (each missing column just empties that breakdown):
--   reason_desc   text     -- human reason description
--   customer_id   text
--   customer_name text
--   order_no      text     -- original sales order, for damage-report matching
--   invoice_no    text
--   item_id       text
--   item_desc     text
--   route_code    text     -- delivery route the original shipment went out on
--   driver_name   text     -- driver on that route
--   picker_name   text     -- warehouse puller who built the pallet
--   warehouse_id  text     -- location the return came back to
--
-- If dedicated RMA tables exist, the equivalent is roughly:
--   FROM dbo.rma_hdr h JOIN dbo.rma_line l ON l.rma_no = h.rma_no
SELECT h.order_no                                   AS rma_no,
       CAST(h.order_date AS DATE)                   AS rma_date,
       h.customer_id                                AS customer_id,
       c.customer_name                              AS customer_name,
       h.po_no                                      AS order_no,
       NULL                                         AS invoice_no,
       im.item_id                                   AS item_id,
       im.item_desc                                 AS item_desc,
       ABS(SUM(l.qty_ordered))                      AS qty,
       ABS(SUM(l.extended_price))                   AS value,
       l.return_reason                              AS reason_code,
       NULL                                         AS reason_desc,
       sr.route_code                                AS route_code,
       NULL                                         AS driver_name,
       NULL                                         AS picker_name,
       h.location_id                                AS warehouse_id
  FROM dbo.oe_hdr h
  JOIN dbo.oe_line l   ON l.order_no = h.order_no
  JOIN dbo.inv_mast im ON im.inv_mast_uid = l.inv_mast_uid
  LEFT JOIN dbo.customer c ON c.customer_id = h.customer_id
  LEFT JOIN dbo.shipping_route sr ON sr.shipping_route_uid = h.shipping_route_uid
 WHERE ISNULL(h.delete_flag, 'N') = 'N'
   AND ISNULL(l.delete_flag, 'N') = 'N'
   AND l.qty_ordered < 0
   AND h.order_date >= DATEADD(month, -24, CAST(GETDATE() AS DATE))
 GROUP BY h.order_no, CAST(h.order_date AS DATE), h.customer_id, c.customer_name,
          h.po_no, im.item_id, im.item_desc, l.return_reason, sr.route_code, h.location_id;`;

export async function getRmaSqlSetting(): Promise<{ sql: string | null; updatedAt: string | null }> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value, updated_at")
    .eq("key", RMA_SQL_SETTING_KEY)
    .maybeSingle();
  const raw = (data as any)?.value;
  const sql = typeof raw === "string" ? raw : (raw?.sql ?? null);
  return { sql: sql ? String(sql) : null, updatedAt: (data as any)?.updated_at ?? null };
}

export async function saveRmaSqlSetting(sql: string | null): Promise<void> {
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key: RMA_SQL_SETTING_KEY, value: { sql: sql ?? null } as any, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

export async function effectiveRmaSql(): Promise<{ sql: string; isCustom: boolean }> {
  const { sql } = await getRmaSqlSetting();
  const trimmed = String(sql ?? "").trim();
  return trimmed ? { sql: trimmed, isCustom: true } : { sql: DEFAULT_RMA_SQL, isCustom: false };
}

/** Case-insensitive column pick from a bridge row. */
function pick(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(row)) if (k.toLowerCase() === lower) return row[k];
  return undefined;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function dateOnly(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const CONTRACT_COLUMNS = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

/** Map one bridge row onto an rma_snapshot_rows insert payload. */
export function mapRmaRow(raw: Record<string, unknown>, snapshotId: string) {
  const reason_code = str(pick(raw, "reason_code"));
  const reason_desc = str(pick(raw, "reason_desc"));
  // Anything outside the contract is preserved in `raw` so a later column
  // rename doesn't lose data already pulled.
  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    if (!CONTRACT_COLUMNS.has(k.toLowerCase())) extras[k] = raw[k];
  }
  return {
    snapshot_id: snapshotId,
    rma_no: str(pick(raw, "rma_no")),
    rma_date: dateOnly(pick(raw, "rma_date")),
    customer_id: str(pick(raw, "customer_id")),
    customer_name: str(pick(raw, "customer_name")),
    order_no: str(pick(raw, "order_no")),
    invoice_no: str(pick(raw, "invoice_no")),
    item_id: str(pick(raw, "item_id")),
    item_desc: str(pick(raw, "item_desc")),
    qty: Math.abs(num(pick(raw, "qty"))),
    value: Math.abs(num(pick(raw, "value"))),
    reason_code,
    reason_desc,
    reason_bucket: bucketReason(reason_code, reason_desc),
    route_code: str(pick(raw, "route_code")),
    driver_name: str(pick(raw, "driver_name")),
    picker_name: str(pick(raw, "picker_name")),
    warehouse_id: str(pick(raw, "warehouse_id")),
    raw: extras as any,
  };
}

export type RmaSnapshotResult = {
  ok: boolean;
  snapshotId: string | null;
  rowsPulled: number;
  rowsWritten: number;
  monthlyRows: number;
  warnings: string[];
  error?: string;
};

async function logEvent(event_type: string, message: string, metadata: Record<string, unknown>) {
  await supabaseAdmin.from("activity_events").insert({
    event_type,
    entity_type: "rma_snapshot",
    message,
    metadata: metadata as any,
  });
}

/**
 * Pull the RMA extract through the bridge and replace the snapshot data.
 * Never throws — every failure mode returns `{ ok: false, error }` and is
 * recorded on the snapshot row so the UI can show what broke.
 */
export async function runRmaSnapshot(
  opts: { triggeredBy?: string | null; timeoutMs?: number } = {},
): Promise<RmaSnapshotResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const warnings: string[] = [];
  const { sql: sqlText, isCustom } = await effectiveRmaSql();

  const fail = async (error: string, stage: string, snapshotId: string | null, rowsPulled = 0) => {
    if (snapshotId) {
      await supabaseAdmin.from("rma_snapshots").update({
        status: "error", error, completed_at: new Date().toISOString(), rows_pulled: rowsPulled,
      }).eq("id", snapshotId);
    }
    await logEvent("rma.snapshot_failed", `RMA snapshot failed (${stage}): ${error}`, { stage, isCustom });
    return { ok: false, snapshotId, rowsPulled, rowsWritten: 0, monthlyRows: 0, warnings, error } satisfies RmaSnapshotResult;
  };

  // 1. Read-only guard + output contract, before we pay a bridge round-trip.
  try { validateSelectSql(sqlText); }
  catch (e: any) { return fail(e?.message ?? String(e), "validate", null); }

  const textCheck = validateRmaSqlText(sqlText);
  if (textCheck.errors.length > 0) {
    return fail(`Output column contract failed: ${textCheck.errors.join(" ")}`, "validate_columns", null);
  }
  warnings.push(...textCheck.warnings);

  const { data: snap, error: snapErr } = await supabaseAdmin
    .from("rma_snapshots")
    .insert({ status: "running", sql_used: sqlText, triggered_by: opts.triggeredBy ?? null })
    .select("id")
    .single();
  if (snapErr || !snap) {
    return fail(snapErr?.message ?? "could not create snapshot row", "create_snapshot", null);
  }
  const snapshotId = snap.id as string;

  // 2. Execute through the bridge agent.
  let rows: Array<Record<string, unknown>> = [];
  try {
    const { result } = await runJob(
      "sql.select",
      { sql: stripLeadingSqlComments(sqlText), params: {}, slug: "rma-snapshot" },
      timeoutMs,
    );
    rows = ((result as any)?.rows ?? []) as Array<Record<string, unknown>>;
  } catch (e: any) {
    return fail(e?.message ?? String(e), "execute", snapshotId);
  }

  // 3. Runtime shape check — refuse to write junk.
  const outCheck = validateRmaSqlOutput(rows);
  if (outCheck.errors.length > 0) {
    return fail(`Output row shape failed: ${outCheck.errors.join(" ")}`, "validate_output", snapshotId, rows.length);
  }
  warnings.push(...outCheck.warnings);

  if (rows.length === 0) {
    await supabaseAdmin.from("rma_snapshots").update({
      status: "ok", completed_at: new Date().toISOString(), rows_pulled: 0, rows_written: 0,
      notes: "Query returned 0 rows — previous snapshot data left in place.",
    }).eq("id", snapshotId);
    warnings.push("Query returned 0 rows; the previous snapshot is still the active dataset.");
    return { ok: true, snapshotId, rowsPulled: 0, rowsWritten: 0, monthlyRows: 0, warnings };
  }

  // 4. Insert mapped rows in chunks.
  const mapped = rows.map((r) => mapRmaRow(r, snapshotId));
  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < mapped.length; i += CHUNK) {
    const slice = mapped.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin.from("rma_snapshot_rows").insert(slice as any);
    if (error) return fail(`row insert failed at offset ${i}: ${error.message}`, "insert", snapshotId, rows.length);
    written += slice.length;
  }

  // 5. Rebuild the per-entity monthly rollups (FUTURE MODEL HOOK table).
  let monthlyRows = 0;
  try {
    monthlyRows = await rebuildEntityMonthly(mapped as RmaRow[]);
  } catch (e: any) {
    warnings.push(`Monthly rollup rebuild failed: ${e?.message ?? String(e)}`);
  }

  await supabaseAdmin.from("rma_snapshots").update({
    status: "ok", completed_at: new Date().toISOString(), rows_pulled: rows.length, rows_written: written,
    notes: warnings.length ? warnings.join(" | ").slice(0, 4000) : null,
  }).eq("id", snapshotId);

  // 6. Prune older snapshots so the table can't grow unbounded (keep last 5).
  try {
    const { data: old } = await supabaseAdmin
      .from("rma_snapshots").select("id").order("started_at", { ascending: false }).range(5, 100);
    const ids = (old ?? []).map((r: any) => r.id);
    if (ids.length > 0) await supabaseAdmin.from("rma_snapshots").delete().in("id", ids);
  } catch { /* pruning is best-effort */ }

  await logEvent("rma.snapshot_ok", `RMA snapshot pulled ${rows.length} rows (${written} written)`, {
    snapshotId, rowsPulled: rows.length, rowsWritten: written, monthlyRows, isCustom,
  });

  return { ok: true, snapshotId, rowsPulled: rows.length, rowsWritten: written, monthlyRows, warnings };
}

/** Replace rma_entity_monthly with rollups derived from the given rows. */
export async function rebuildEntityMonthly(rows: RmaRow[]): Promise<number> {
  const aggs = entityMonthlyAggregates(rows);
  await supabaseAdmin.from("rma_entity_monthly").delete().neq("dimension_type", "__none__");
  const payload = aggs.map((a) => ({
    dimension_type: a.dimension_type,
    dimension_key: a.dimension_key,
    dimension_label: a.dimension_label,
    month: a.month,
    rma_count: a.rma_count,
    rma_value: a.rma_value,
    rma_qty: a.rma_qty,
    reason_counts: a.reason_counts as any,
    reason_values: a.reason_values as any,
    updated_at: new Date().toISOString(),
  }));
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("rma_entity_monthly")
      .upsert(payload.slice(i, i + CHUNK) as any, { onConflict: "dimension_type,dimension_key,month" });
    if (error) throw new Error(error.message);
  }
  return payload.length;
}

/* ============================== READ SIDE ============================== */

export async function latestSnapshot() {
  const { data } = await supabaseAdmin
    .from("rma_snapshots")
    .select("*")
    .eq("status", "ok")
    .gt("rows_written", 0)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** Fetch all rows of the active snapshot in a date window (PostgREST caps at 1000). */
export async function loadSnapshotRows(range: { from?: string | null; to?: string | null } = {}) {
  const snap = await latestSnapshot();
  if (!snap) return { snapshot: null, rows: [] as any[] };
  const out: any[] = [];
  const step = 1000;
  for (let offset = 0; ; offset += step) {
    let q = supabaseAdmin
      .from("rma_snapshot_rows")
      .select("*")
      .eq("snapshot_id", (snap as any).id)
      .order("rma_date", { ascending: false })
      .range(offset, offset + step - 1);
    if (range.from) q = q.gte("rma_date", range.from);
    if (range.to) q = q.lte("rma_date", range.to);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < step) break;
  }
  return { snapshot: snap, rows: out };
}

/**
 * Shipment-volume denominators, "where available". Truck run history is the
 * only real historical shipment source in the app today:
 *   route  -> number of logged runs on that route in the window
 *   driver -> number of logged runs that driver made
 * Picker, dealer and warehouse have no denominator, so those breakdowns fall
 * back to reason-share outlier detection.
 */
export async function shipmentVolumes(range: { from?: string | null; to?: string | null }) {
  const byRoute = new Map<string, number>();
  const byDriver = new Map<string, number>();
  const { data: routes } = await supabaseAdmin
    .from("truck_capacity_routes").select("id, code, p21_route_code");
  const routeCodeById = new Map<string, string[]>();
  for (const r of routes ?? []) {
    const codes = [String((r as any).code ?? "")];
    const p21 = String((r as any).p21_route_code ?? "");
    if (p21) codes.push(...p21.split(",").map((s) => s.trim()));
    routeCodeById.set((r as any).id, codes.filter(Boolean));
  }
  let q = supabaseAdmin.from("truck_capacity_runs").select("route_id, driver, run_date").limit(50000);
  if (range.from) q = q.gte("run_date", range.from);
  if (range.to) q = q.lte("run_date", range.to);
  const { data: runs } = await q;
  for (const run of runs ?? []) {
    for (const code of routeCodeById.get((run as any).route_id) ?? []) {
      const k = code.toLowerCase();
      byRoute.set(k, (byRoute.get(k) ?? 0) + 1);
    }
    const d = String((run as any).driver ?? "").trim().toLowerCase();
    if (d) byDriver.set(d, (byDriver.get(d) ?? 0) + 1);
  }
  return { byRoute, byDriver };
}

/** Order/RMA numbers present in the active snapshot, for damage-report cross-linking. */
export async function snapshotOrderIndex(): Promise<{ snapshotId: string | null; keys: string[] }> {
  const snap = await latestSnapshot();
  if (!snap) return { snapshotId: null, keys: [] };
  const keys = new Set<string>();
  const step = 1000;
  for (let offset = 0; ; offset += step) {
    const { data, error } = await supabaseAdmin
      .from("rma_snapshot_rows")
      .select("rma_no, order_no")
      .eq("snapshot_id", (snap as any).id)
      .range(offset, offset + step - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const a = String((r as any).rma_no ?? "").trim();
      const b = String((r as any).order_no ?? "").trim();
      if (a) keys.add(a.toUpperCase());
      if (b) keys.add(b.toUpperCase());
    }
    if (!data || data.length < step) break;
  }
  return { snapshotId: (snap as any).id, keys: Array.from(keys) };
}

export { monthKey };
