import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdmin, runJob } from "./p21.server";
import {
  computeForecastForRoute, exportCapacityWorkbook, parseImportWorkbook, applyImportRows,
  runP21Snapshot, DEFAULT_P21_SQL,
} from "./truck-capacity.server";
import { validateSelectSql } from "./sql-schedules.server";

async function requireOpsOrAdmin(userId: string) {
  const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (data) return;
  const { data: ops } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: "ops_orders" });
  if (!ops) throw new Error("ops_orders or admin role required");
}

export const listTruckRoutes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("truck_capacity_routes").select("*")
      .order("hub", { ascending: true }).order("sort_order", { ascending: true });
    if (error) throw new Error(error.message);
    return { routes: data ?? [] };
  });

export const listTruckRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    routeId: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  }).parse(i))
  .handler(async ({ data }) => {
    let q = supabaseAdmin.from("truck_capacity_runs").select("*").order("run_date", { ascending: false });
    if (data.routeId) q = q.eq("route_id", data.routeId);
    if (data.from) q = q.gte("run_date", data.from);
    if (data.to) q = q.lte("run_date", data.to);
    q = q.limit(data.limit ?? 500);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

const UpsertRun = z.object({
  id: z.string().uuid().optional(),
  route_id: z.string().uuid(),
  run_date: z.string(),
  run_seq: z.number().int().min(1).max(10).default(1),
  capacity_frac: z.number().min(0).max(1.25),
  vendor_pickup_frac: z.number().min(0).max(1.25).nullable().optional(),
  driver: z.string().nullable().optional(),
  pallet_count: z.number().int().nullable().optional(),
  returned_pallets: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const upsertTruckRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => UpsertRun.parse(i))
  .handler(async ({ data, context }) => {
    await requireOpsOrAdmin(context.userId);
    const payload = { ...data, source: "manual", entered_by: context.userId };
    if (data.id) {
      const { error } = await supabaseAdmin.from("truck_capacity_runs").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: ins, error } = await supabaseAdmin
      .from("truck_capacity_runs")
      .upsert(payload, { onConflict: "route_id,run_date,run_seq" })
      .select("id").single();
    if (error || !ins) throw new Error(error?.message ?? "insert failed");
    return { id: ins.id };
  });

export const deleteTruckRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireOpsOrAdmin(context.userId);
    const { error } = await supabaseAdmin.from("truck_capacity_runs").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getTruckForecast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ routeId: z.string().uuid(), horizonDays: z.number().int().min(1).max(60).optional() }).parse(i))
  .handler(async ({ data }) => computeForecastForRoute(data.routeId, data.horizonDays ?? 28));

export const getTruckSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data } = await supabaseAdmin.from("truck_capacity_settings").select("*").eq("singleton", true).maybeSingle();
    return { settings: data, defaultP21Sql: DEFAULT_P21_SQL };
  });

export const updateTruckSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    capacity_basis: z.enum(["pallets", "weight", "cube"]),
    vendor_pickup_counts: z.boolean(),
    p21_sql: z.string().max(20000).nullable().optional(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    const { error } = await supabaseAdmin.from("truck_capacity_settings")
      .update({ ...data, updated_by: context.userId }).eq("singleton", true);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const updateRoutePalletsPerTruck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    updates: z.array(z.object({ id: z.string().uuid(), pallets_full_truck: z.number().int().min(1).max(60).nullable() })).max(100),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    for (const u of data.updates) {
      const { error } = await supabaseAdmin.from("truck_capacity_routes")
        .update({ pallets_full_truck: u.pallets_full_truck }).eq("id", u.id);
      if (error) throw new Error(error.message);
    }
    return { ok: true, updated: data.updates.length };
  });

export const previewTruckImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ fileBase64: z.string().min(1) }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    const report = await parseImportWorkbook(data.fileBase64);
    return { sheets: report.sheets, totalOk: report.totalOk, rows: report.rows };
  });

export const commitTruckImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    rows: z.array(z.object({
      route_code: z.string(),
      run_date: z.string(),
      run_seq: z.number().int().min(1),
      capacity_frac: z.number(),
      vendor_pickup_frac: z.number().nullable(),
      driver: z.string().nullable(),
      pallet_count: z.number().int().nullable(),
      returned_pallets: z.number().int().nullable(),
      notes: z.string().nullable(),
    })).max(20000),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    return applyImportRows(data.rows);
  });


export const exportTruckWorkbook = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const buf = await exportCapacityWorkbook();
    return { base64: buf.toString("base64"), filename: `truck-capacity-${new Date().toISOString().slice(0,10)}.xlsx` };
  });

export const runP21SnapshotNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(null, context.userId);
    return runP21Snapshot();
  });

export const testP21Sql = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ sql: z.string().min(1).max(20000) }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    // Defense-in-depth: block anything that isn't a read-only SELECT/WITH/DECLARE.
    validateSelectSql(data.sql);
    const { result } = await runJob("sql.select", { sql: data.sql, params: {}, slug: "truck-capacity-test" }, 60_000);
    const rows = ((result as any)?.rows ?? []) as any[];
    return { rowCount: rows.length, sample: rows.slice(0, 10) };
  });

