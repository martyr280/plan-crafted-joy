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
  .inputValidator((i) => z.object({
    routeId: z.string().uuid(),
    horizonDays: z.number().int().min(1).max(60).optional(),
    method: z.enum(["auto", "baseline", "model"]).optional(),
  }).parse(i))
  .handler(async ({ data }) => computeForecastForRoute(data.routeId, data.horizonDays ?? 28, data.method ?? "auto"));

export const retrainTruckModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(null, context.userId);
    const { trainAndMaybePromote } = await import("./truck-capacity/train");
    return trainAndMaybePromote(context.userId);
  });

export const listTruckModelVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data, error } = await supabaseAdmin
      .from("truck_capacity_model_versions")
      .select("id, trained_at, lambda, blend_w, train_rows, holdout_mae_baseline, holdout_mae_model, holdout_mae_blend, wape_baseline, wape_model, wape_blend, promoted, notes")
      .order("trained_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return { versions: data ?? [] };
  });

export const getTruckAccuracy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data: promoted } = await supabaseAdmin
      .from("truck_capacity_model_versions")
      .select("id, trained_at, lambda, blend_w, holdout_mae_baseline, holdout_mae_model, holdout_mae_blend, wape_baseline, wape_model, wape_blend, per_route_mae, notes")
      .eq("promoted", true).order("trained_at", { ascending: false }).limit(1).maybeSingle();
    const { data: latest } = await supabaseAdmin
      .from("truck_capacity_model_versions")
      .select("id, trained_at, lambda, blend_w, holdout_mae_baseline, holdout_mae_model, holdout_mae_blend, wape_baseline, wape_model, wape_blend, per_route_mae, promoted, notes")
      .order("trained_at", { ascending: false }).limit(1).maybeSingle();
    return { promoted: promoted ?? null, latest: latest ?? null };
  });


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
    updates: z.array(z.object({
      id: z.string().uuid(),
      pallets_full_truck: z.number().int().min(1).max(60).nullable().optional(),
      cube_full_truck_ft3: z.number().min(0).max(20000).nullable().optional(),
      weight_full_truck_lbs: z.number().min(0).max(200000).nullable().optional(),
      p21_route_code: z.string().max(64).nullable().optional(),
      cutoff_time: z.string().max(32).nullable().optional(),
    })).max(200),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    for (const u of data.updates) {
      const { id, ...rest } = u;
      // Only include keys that were explicitly provided (undefined = untouched).
      const patch: Record<string, any> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from("truck_capacity_routes").update(patch).eq("id", id);
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
    const result = await applyImportRows(data.rows);
    // Best-effort retrain after import so accuracy metrics reflect the new data.
    let retrain: any = null;
    try {
      const { trainAndMaybePromote } = await import("./truck-capacity/train");
      retrain = await trainAndMaybePromote(context.userId);
    } catch (e: any) { retrain = { ok: false, error: e?.message ?? String(e) }; }
    return { ...result, retrain };
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

