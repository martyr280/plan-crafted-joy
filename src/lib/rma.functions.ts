import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import { validateSelectSql, stripLeadingSqlComments } from "./sql-schedules.server";
import {
  DEFAULT_RMA_SQL,
  effectiveRmaSql,
  getRmaSqlSetting,
  saveRmaSqlSetting,
  runRmaSnapshot,
  loadSnapshotRows,
  shipmentVolumes,
  snapshotOrderIndex,
  validateRmaSqlText,
  validateRmaSqlOutput,
} from "./rma.server";
import {
  aggregateByDimension,
  monthlyTrend,
  DIMENSIONS,
  num,
  rowBucket,
  type DimensionType,
} from "./rma/attribution";
import { emptyReasonMap } from "./rma/reasons";

async function hasAnyRoleSrv(userId: string, roles: string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireRmaAdmin(userId: string) {
  const ok = await hasAnyRoleSrv(userId, ["admin", "ops_logistics_admin"]);
  if (!ok) throw new Error("Logistics admin or admin role required");
}

const RangeInput = z.object({
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
});

/* ============================== DATA SOURCE ============================== */

export const getRmaDataSource = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireRmaAdmin(context.userId);
    const setting = await getRmaSqlSetting();
    const { data: snapshots } = await supabaseAdmin
      .from("rma_snapshots")
      .select("id, status, started_at, completed_at, rows_pulled, rows_written, error, notes")
      .order("started_at", { ascending: false })
      .limit(10);
    return {
      defaultSql: DEFAULT_RMA_SQL,
      customSql: setting.sql,
      updatedAt: setting.updatedAt,
      snapshots: snapshots ?? [],
    };
  });

export const saveRmaDataSource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ sql: z.string().max(30000).nullable() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireRmaAdmin(context.userId);
    const trimmed = String(data.sql ?? "").trim();
    if (trimmed) {
      validateSelectSql(trimmed);
      const check = validateRmaSqlText(trimmed);
      if (check.errors.length > 0) {
        throw new Error(`Output contract failed: ${check.errors.join(" ")}`);
      }
      await saveRmaSqlSetting(trimmed);
      return { ok: true, warnings: check.warnings };
    }
    await saveRmaSqlSetting(null);
    return { ok: true, warnings: ["Reverted to the built-in default query."] };
  });

/** Dry run: execute the SQL, report columns + row count, write nothing. */
export const testRmaSql = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ sql: z.string().min(1).max(30000) }).parse(i))
  .handler(async ({ data, context }) => {
    await requireRmaAdmin(context.userId);
    validateSelectSql(data.sql);
    const textCheck = validateRmaSqlText(data.sql);
    if (textCheck.errors.length > 0) {
      throw new Error(`Output contract failed: ${textCheck.errors.join(" ")}`);
    }
    const { result } = await runJob(
      "sql.select",
      { sql: stripLeadingSqlComments(data.sql), params: {}, slug: "rma-snapshot-test", maxRows: 500 },
      90_000,
    );
    const rows = ((result as any)?.rows ?? []) as any[];
    const columns = ((result as any)?.columns ?? Object.keys(rows[0] ?? {})) as string[];
    const outCheck = validateRmaSqlOutput(rows);
    return {
      rowCount: rows.length,
      columns,
      sample: rows.slice(0, 10),
      validation: {
        errors: [...textCheck.errors, ...outCheck.errors],
        warnings: [...textCheck.warnings, ...outCheck.warnings],
      },
    };
  });

export const runRmaSnapshotNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireRmaAdmin(context.userId);
    return await runRmaSnapshot({ triggeredBy: context.userId });
  });

/* ============================== ANALYTICS ============================== */

export const getRmaOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => RangeInput.parse(i))
  .handler(async ({ data }) => {
    const { snapshot, rows } = await loadSnapshotRows({ from: data.from, to: data.to });
    const totalValue = rows.reduce((s, r) => s + num(r.value), 0);
    const totalQty = rows.reduce((s, r) => s + num(r.qty), 0);
    const reasonMix = emptyReasonMap();
    const reasonValue = emptyReasonMap();
    const rmaNos = new Set<string>();
    for (const r of rows) {
      const b = rowBucket(r);
      reasonMix[b] += 1;
      reasonValue[b] += num(r.value);
      const n = String(r.rma_no ?? "").trim();
      if (n) rmaNos.add(n.toUpperCase());
    }
    return {
      snapshot,
      lineCount: rows.length,
      rmaCount: rmaNos.size,
      totalValue,
      totalQty,
      reasonMix,
      reasonValue,
      trend: monthlyTrend(rows),
    };
  });

export const getRmaAttribution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    RangeInput.extend({
      dimension: z.enum(DIMENSIONS).optional(),
      minIncidents: z.number().int().min(1).max(100).optional(),
      multiple: z.number().min(1).max(10).optional(),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    const { snapshot, rows } = await loadSnapshotRows({ from: data.from, to: data.to });
    const volumes = await shipmentVolumes({ from: data.from, to: data.to });
    const config = {
      multiple: data.multiple ?? 2,
      minIncidents: data.minIncidents ?? 5,
    };
    const dims: DimensionType[] = data.dimension ? [data.dimension] : [...DIMENSIONS];
    const result: Record<string, ReturnType<typeof aggregateByDimension>> = {};
    for (const dim of dims) {
      const volMap =
        dim === "route" ? volumes.byRoute : dim === "driver" ? volumes.byDriver : undefined;
      result[dim] = aggregateByDimension(rows, dim, volMap, config);
    }
    return { snapshot, dimensions: result, config, lineCount: rows.length };
  });

export const listRmaRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    RangeInput.extend({
      search: z.string().max(200).optional(),
      bucket: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(20000).optional(),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    const { snapshot, rows } = await loadSnapshotRows({ from: data.from, to: data.to });
    let out = rows;
    if (data.bucket && data.bucket !== "all") {
      out = out.filter((r) => rowBucket(r) === data.bucket);
    }
    const q = String(data.search ?? "").trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        [r.rma_no, r.order_no, r.invoice_no, r.customer_name, r.customer_id, r.item_id, r.item_desc,
         r.reason_code, r.reason_desc, r.route_code, r.driver_name, r.picker_name, r.warehouse_id]
          .some((v) => String(v ?? "").toLowerCase().includes(q)),
      );
    }
    const total = out.length;
    return { snapshot, total, rows: out.slice(0, data.limit ?? 2000) };
  });

/** Per-entity monthly rollups — the queryable surface a future model trains on. */
export const listRmaEntityMonthly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({
      dimensionType: z.enum(DIMENSIONS).optional(),
      dimensionKey: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }).parse(i),
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin
      .from("rma_entity_monthly")
      .select("*")
      .order("month", { ascending: false })
      .limit(data.limit ?? 2000);
    if (data.dimensionType) q = q.eq("dimension_type", data.dimensionType);
    if (data.dimensionKey) q = q.eq("dimension_key", data.dimensionKey);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

/**
 * Order/RMA keys in the active snapshot, so the Damage Tracker can show a
 * cross-link indicator on damage reports that match a return.
 */
export const getRmaOrderIndex = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    return await snapshotOrderIndex();
  });

export const getRmaSqlPreview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireRmaAdmin(context.userId);
    return await effectiveRmaSql();
  });
