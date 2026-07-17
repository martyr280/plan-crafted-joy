import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdmin, runJob } from "./p21.server";
import {
  computeForecastForRoute, exportCapacityWorkbook, parseImportWorkbook, applyImportRows,
  runP21Snapshot, DEFAULT_P21_SQL, DEFAULT_P21_TRANSFER_SQL,
  validateP21SqlText, validateP21SqlOutput,
} from "./truck-capacity.server";
import { validateSelectSql, stripLeadingSqlComments } from "./sql-schedules.server";

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
    return {
      settings: data,
      defaultP21Sql: DEFAULT_P21_SQL,
      defaultP21TransferSql: DEFAULT_P21_TRANSFER_SQL,
    };
  });

export const updateTruckSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    capacity_basis: z.enum(["pallets", "weight", "cube"]),
    vendor_pickup_counts: z.boolean(),
    p21_sql: z.string().max(20000).nullable().optional(),
    p21_transfer_sql: z.string().max(20000).nullable().optional(),
    excluded_p21_codes: z.array(z.string().max(64)).max(200).nullable().optional(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    // Sanity-check any custom SQL text before persisting. Null/empty means
    // "use the default" — no check needed. A stored query that fails the
    // column contract would silently poison every nightly snapshot, so we
    // refuse the save instead.
    for (const [field, sql] of [
      ["p21_sql", data.p21_sql],
      ["p21_transfer_sql", data.p21_transfer_sql],
    ] as const) {
      if (sql == null) continue;
      const trimmed = sql.trim();
      if (!trimmed) continue;
      try { validateSelectSql(trimmed); }
      catch (e: any) { throw new Error(`${field}: ${e?.message ?? String(e)}`); }
      const kind = field === "p21_transfer_sql" ? "transfers" : "orders";
      const check = validateP21SqlText(trimmed, kind);
      if (check.errors.length > 0) {
        throw new Error(`${field} output contract failed: ${check.errors.join(" ")}`);
      }
    }
    // Normalize excluded codes (uppercase, trimmed, deduped) so matcher can
    // rely on a stable case-insensitive compare and admins see a clean list.
    const patch: Record<string, any> = { ...data, updated_by: context.userId };
    if (data.excluded_p21_codes !== undefined) {
      const norm = Array.from(new Set(
        (data.excluded_p21_codes ?? [])
          .map((s) => String(s ?? "").trim().toUpperCase())
          .filter(Boolean),
      ));
      patch.excluded_p21_codes = norm;
    }
    const { error } = await supabaseAdmin.from("truck_capacity_settings")
      .update(patch as any).eq("singleton", true);
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
      p21_route_code: z.string().max(128).nullable().optional(),
      cutoff_time: z.string().max(128).nullable().optional(),
      p21_cities: z.array(z.string().max(80)).max(50).nullable().optional(),
      p21_states: z.array(z.string().max(4)).max(20).nullable().optional(),
      ship_to_zip_prefixes: z.array(z.string().max(6)).max(50).nullable().optional(),
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
      const { error } = await supabaseAdmin.from("truck_capacity_routes").update(patch as any).eq("id", id);
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

async function buildSnapshotReadout(startedAt: Date) {
  const { data: rows } = await supabaseAdmin
    .from("truck_capacity_p21_demand")
    .select("route_id, ship_date, projected_capacity_frac, total_cube_ft, total_weight_lbs, est_pallets, order_count")
    .gte("created_at", startedAt.toISOString())
    .limit(50000);
  const list = rows ?? [];
  const withFrac = list.filter((r) => r.projected_capacity_frac != null);
  const fracs = withFrac.map((r) => Number(r.projected_capacity_frac));
  const min = fracs.length ? Math.min(...fracs) : null;
  const max = fracs.length ? Math.max(...fracs) : null;
  const avg = fracs.length ? fracs.reduce((a, b) => a + b, 0) / fracs.length : null;
  const capped = fracs.filter((f) => f >= 1.499999).length;
  const routeIds = Array.from(new Set(withFrac.map((r) => r.route_id)));
  const { data: routeRows } = routeIds.length
    ? await supabaseAdmin.from("truck_capacity_routes").select("id, code, hub").in("id", routeIds)
    : { data: [] as { id: string; code: string; hub: string }[] };
  const codeById = new Map((routeRows ?? []).map((r) => [r.id, `${r.code} · ${r.hub}`]));
  const top5 = [...withFrac]
    .sort((a, b) => Number(b.projected_capacity_frac) - Number(a.projected_capacity_frac))
    .slice(0, 5)
    .map((r) => ({
      route: codeById.get(r.route_id) ?? r.route_id,
      ship_date: r.ship_date,
      projected_capacity_frac: Number(Number(r.projected_capacity_frac).toFixed(3)),
      total_cube_ft: r.total_cube_ft,
      total_weight_lbs: r.total_weight_lbs,
      est_pallets: r.est_pallets,
      order_count: r.order_count,
    }));
  return {
    demandRowsWritten: list.length,
    rowsWithProjection: withFrac.length,
    projectedFracMin: min,
    projectedFracMax: max,
    projectedFracAvg: avg,
    rowsAtCap_1_5: capped,
    top5ByProjectedFrac: top5,
  };
}

function plausibilityWarnings(
  r: { avg: number | null; min: number | null; max: number | null; count: number; capped: number },
  unmatched: string[],
) {
  const warnings: string[] = [];
  if (r.count === 0) {
    warnings.push("No rows have projected_capacity_frac — every route lacks cube/weight full-truck targets, or nothing matched.");
  } else {
    if (r.avg != null && r.avg < 0.02) warnings.push(`Average projection ${r.avg.toFixed(3)} is implausibly low — check that total_cube_ft / total_weight_lbs are populated.`);
    if (r.max != null && r.max >= 1.5 && r.capped / r.count > 0.5) warnings.push(">50% of rows hit the 1.5 cap — full-truck targets are likely too small.");
    if (r.min != null && r.min > 0.9) warnings.push(`Minimum projection ${r.min.toFixed(3)} is suspiciously high — every day looks near-capacity.`);
  }
  if (unmatched.length > 0) warnings.push(`Unmatched route codes: ${unmatched.join(", ")} — map or exclude them in Settings.`);
  return warnings;
}

export const runP21SnapshotNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(null, context.userId);
    const startedAt = new Date();
    const result = await runP21Snapshot({ kind: "orders" });
    if (!result.ok) return { ...result, readout: null, warnings: [] as string[] };
    const readout = await buildSnapshotReadout(startedAt);
    const warnings = plausibilityWarnings(
      { avg: readout.projectedFracAvg, min: readout.projectedFracMin, max: readout.projectedFracMax, count: readout.rowsWithProjection, capped: readout.rowsAtCap_1_5 },
      result.unmatchedRouteCodes,
    );
    return { ...result, readout, warnings };
  });

export const runP21TransferSnapshotNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(null, context.userId);
    const startedAt = new Date();
    const result = await runP21Snapshot({ kind: "transfers" });
    if (!result.ok) return { ...result, readout: null, warnings: [] as string[] };
    const readout = await buildSnapshotReadout(startedAt);
    const warnings = plausibilityWarnings(
      { avg: readout.projectedFracAvg, min: readout.projectedFracMin, max: readout.projectedFracMax, count: readout.rowsWithProjection, capped: readout.rowsAtCap_1_5 },
      result.unmatchedRouteCodes,
    );
    return { ...result, readout, warnings };
  });

export const testP21Sql = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ sql: z.string().min(1).max(20000) }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    // Defense-in-depth: block anything that isn't a read-only SELECT/WITH/DECLARE.
    validateSelectSql(data.sql);
    // Column-alias smell test before we ship the query to the bridge.
    const textCheck = validateP21SqlText(data.sql, "orders");
    if (textCheck.errors.length > 0) {
      throw new Error(`Output contract failed: ${textCheck.errors.join(" ")}`);
    }
    const { result } = await runJob("sql.select", { sql: stripLeadingSqlComments(data.sql), params: {}, slug: "truck-capacity-test" }, 60_000);
    const rows = ((result as any)?.rows ?? []) as any[];
    // Runtime output-shape check against the actual sample. Surface as
    // findings (not a throw) so admins see column/type mismatches side-by-side
    // with the sample rows in the Test dialog.
    const outCheck = validateP21SqlOutput(rows, "orders");
    return {
      rowCount: rows.length,
      sample: rows.slice(0, 10),
      validation: {
        errors: [...textCheck.errors, ...outCheck.errors],
        warnings: [...textCheck.warnings, ...outCheck.warnings],
      },
    };
  });

export const testP21TransferSql = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ sql: z.string().min(1).max(20000) }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    validateSelectSql(data.sql);
    const textCheck = validateP21SqlText(data.sql, "transfers");
    if (textCheck.errors.length > 0) {
      throw new Error(`Output contract failed: ${textCheck.errors.join(" ")}`);
    }
    const { result } = await runJob("sql.select", { sql: stripLeadingSqlComments(data.sql), params: {}, slug: "truck-capacity-transfer-test" }, 60_000);
    const rows = ((result as any)?.rows ?? []) as any[];
    const outCheck = validateP21SqlOutput(rows, "transfers");
    return {
      rowCount: rows.length,
      sample: rows.slice(0, 10),
      validation: {
        errors: [...textCheck.errors, ...outCheck.errors],
        warnings: [...textCheck.warnings, ...outCheck.warnings],
      },
    };
  });

/* ================= UNMATCHED P21 ROUTE CODE MAPPING ================= */

// Aggregate recent unmatched codes from `activity_events` (populated by
// `runP21Snapshot`), plus the currently-ignored list, so admins can either
// assign a code to an internal route or hide it permanently.
export const listP21UnmatchedRouteCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(null, context.userId);
    const { data: events } = await supabaseAdmin
      .from("activity_events")
      .select("created_at, message, metadata")
      .eq("event_type", "truck_capacity.p21_snapshot")
      .order("created_at", { ascending: false })
      .limit(40);
    const { data: settings } = await supabaseAdmin
      .from("truck_capacity_settings").select("*").eq("singleton", true).maybeSingle();
    const { data: routes } = await supabaseAdmin
      .from("truck_capacity_routes")
      .select("id, code, name, hub, p21_route_code")
      .order("hub", { ascending: true }).order("sort_order", { ascending: true });

    const ignored: string[] = ((settings as any)?.ignored_p21_route_codes ?? []) as string[];
    const ignoredSet = new Set(ignored.map((s) => String(s).trim().toLowerCase()).filter(Boolean));

    // Build a case-insensitive map of codes already claimed by some route so
    // we don't display codes an admin has already mapped in a later save.
    const claimed = new Set<string>();
    for (const r of routes ?? []) {
      if (r.code) claimed.add(String(r.code).toLowerCase());
      if (r.p21_route_code) {
        for (const p of String(r.p21_route_code).split(",")) {
          const k = p.trim().toLowerCase();
          if (k) claimed.add(k);
        }
      }
    }

    const agg = new Map<string, { code: string; count: number; lastSeen: string; kinds: Set<string> }>();
    for (const ev of events ?? []) {
      const meta = (ev as any).metadata ?? {};
      const kind = String(meta.kind ?? "orders");
      const codes: string[] = Array.isArray(meta.unmatched) ? meta.unmatched : [];
      for (const c of codes) {
        const raw = String(c ?? "").trim();
        if (!raw) continue;
        const key = raw.toLowerCase();
        if (claimed.has(key)) continue; // resolved by a later save
        const entry = agg.get(key) ?? { code: raw, count: 0, lastSeen: (ev as any).created_at, kinds: new Set() };
        entry.count += 1;
        if (new Date((ev as any).created_at) > new Date(entry.lastSeen)) entry.lastSeen = (ev as any).created_at;
        entry.kinds.add(kind);
        agg.set(key, entry);
      }
    }

    const unmatched = Array.from(agg.values())
      .map((e) => ({
        code: e.code,
        occurrences: e.count,
        last_seen: e.lastSeen,
        kinds: Array.from(e.kinds),
        ignored: ignoredSet.has(e.code.toLowerCase()),
      }))
      .sort((a, b) => b.occurrences - a.occurrences || a.code.localeCompare(b.code));

    return {
      unmatched,
      ignored,
      routes: (routes ?? []).map((r) => ({
        id: r.id, code: r.code, name: r.name, hub: r.hub, p21_route_code: r.p21_route_code,
      })),
    };
  });

// Append a P21 code to a route's comma-separated p21_route_code list.
// Case-insensitive dedupe. Also drops the code from the ignore list if
// present so a previously-ignored code can be reclassified.
export const assignP21RouteCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    code: z.string().min(1).max(64),
    routeId: z.string().uuid(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    const code = data.code.trim();
    if (!code) throw new Error("code required");
    const { data: route, error: rErr } = await supabaseAdmin
      .from("truck_capacity_routes")
      .select("id, p21_route_code")
      .eq("id", data.routeId).maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!route) throw new Error("Route not found");
    const existing = String((route as any).p21_route_code ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const already = existing.some((e) => e.toLowerCase() === code.toLowerCase());
    const next = already ? existing : [...existing, code];
    const { error } = await supabaseAdmin
      .from("truck_capacity_routes")
      .update({ p21_route_code: next.join(",") } as any)
      .eq("id", data.routeId);
    if (error) throw new Error(error.message);

    // If it was ignored, remove it — assigning takes precedence.
    const { data: settings } = await supabaseAdmin
      .from("truck_capacity_settings").select("*").eq("singleton", true).maybeSingle();
    const ignored: string[] = ((settings as any)?.ignored_p21_route_codes ?? []) as string[];
    const filtered = ignored.filter((c) => c.toLowerCase() !== code.toLowerCase());
    if (filtered.length !== ignored.length) {
      const { error: sErr } = await supabaseAdmin
        .from("truck_capacity_settings")
        .update({ ignored_p21_route_codes: filtered, updated_by: context.userId } as any)
        .eq("singleton", true);
      if (sErr) throw new Error(sErr.message);
    }

    await supabaseAdmin.from("activity_events").insert({
      event_type: "truck_capacity.route_code_mapped",
      entity_type: "truck_capacity_routes",
      entity_id: data.routeId,
      message: `Mapped P21 route code "${code}" to route ${data.routeId}.`,
      metadata: { code, route_id: data.routeId },
    });
    return { ok: true, alreadyAssigned: already };
  });

export const setP21RouteCodeIgnored = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    code: z.string().min(1).max(64),
    ignore: z.boolean(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await assertAdmin(null, context.userId);
    const code = data.code.trim();
    if (!code) throw new Error("code required");
    const { data: settings } = await supabaseAdmin
      .from("truck_capacity_settings").select("*").eq("singleton", true).maybeSingle();
    const current: string[] = ((settings as any)?.ignored_p21_route_codes ?? []) as string[];
    const lower = code.toLowerCase();
    const withoutIt = current.filter((c) => c.toLowerCase() !== lower);
    const next = data.ignore ? [...withoutIt, code] : withoutIt;
    const { error } = await supabaseAdmin
      .from("truck_capacity_settings")
      .update({ ignored_p21_route_codes: next, updated_by: context.userId } as any)
      .eq("singleton", true);
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("activity_events").insert({
      event_type: data.ignore ? "truck_capacity.route_code_ignored" : "truck_capacity.route_code_unignored",
      entity_type: "truck_capacity_settings",
      message: `${data.ignore ? "Ignored" : "Un-ignored"} P21 route code "${code}".`,
      metadata: { code },
    });
    return { ok: true };
  });

/* ================= CAPACITY COVERAGE REPORT ================= */

// How much of the P21 demand actually gets a projected_capacity_frac vs.
// falls through as null (because the route has no cube/weight/pallets
// full-truck target and est_pallets is NULL under Kevin's verified SQL).
// Powers the "Coverage" card in Settings so admins can see, per route,
// which targets to backfill next.
export const getTruckCapacityCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    days: z.number().int().min(1).max(365).optional(),
  }).parse(i))
  .handler(async ({ data }) => {
    const days = data.days ?? 30;
    const since = new Date(); since.setUTCDate(since.getUTCDate() - days);
    const sinceIso = since.toISOString().slice(0, 10);

    // Fetch demand rows in window. Cap defensive limit at 100k to avoid
    // runaway queries; realistic 30-day snapshot volume is < 5k rows.
    const { data: demand, error: dErr } = await supabaseAdmin
      .from("truck_capacity_p21_demand")
      .select("route_id, projected_capacity_frac, ship_date")
      .gte("ship_date", sinceIso)
      .limit(100000);
    if (dErr) throw new Error(dErr.message);

    const { data: routes, error: rErr } = await supabaseAdmin
      .from("truck_capacity_routes")
      .select("id, code, name, hub, pallets_full_truck, cube_full_truck_ft3, weight_full_truck_lbs, active, sort_order")
      .order("hub", { ascending: true }).order("sort_order", { ascending: true });
    if (rErr) throw new Error(rErr.message);

    type Agg = { rows: number; covered: number };
    const byRoute = new Map<string, Agg>();
    let totalRows = 0, totalCovered = 0;
    for (const d of demand ?? []) {
      totalRows += 1;
      const covered = (d as any).projected_capacity_frac != null;
      if (covered) totalCovered += 1;
      const a = byRoute.get((d as any).route_id) ?? { rows: 0, covered: 0 };
      a.rows += 1; if (covered) a.covered += 1;
      byRoute.set((d as any).route_id, a);
    }

    const perRoute = (routes ?? []).map((r) => {
      const a = byRoute.get(r.id) ?? { rows: 0, covered: 0 };
      const hasCube = r.cube_full_truck_ft3 != null;
      const hasWeight = r.weight_full_truck_lbs != null;
      const hasPallets = r.pallets_full_truck != null;
      const anyTarget = hasCube || hasWeight || hasPallets;
      return {
        id: r.id, code: r.code, name: r.name, hub: r.hub, active: r.active,
        rows: a.rows, covered: a.covered,
        pct: a.rows === 0 ? null : a.covered / a.rows,
        cube_full_truck_ft3: r.cube_full_truck_ft3 == null ? null : Number(r.cube_full_truck_ft3),
        weight_full_truck_lbs: r.weight_full_truck_lbs == null ? null : Number(r.weight_full_truck_lbs),
        pallets_full_truck: r.pallets_full_truck,
        has_cube: hasCube, has_weight: hasWeight, has_pallets: hasPallets, has_any_target: anyTarget,
      };
    });

    // Routes with demand but no cube AND no weight target — since Kevin's
    // verified SQL leaves est_pallets NULL, these are the routes that make
    // projected_capacity_frac null and are the highest-value backfill list.
    const missingCubeAndWeight = perRoute
      .filter((r) => r.rows > 0 && !r.has_cube && !r.has_weight)
      .sort((a, b) => b.rows - a.rows);

    // Routes with demand missing only one of cube/weight — less urgent but
    // useful to know so both can be filled from the same trailer assumption.
    const partialTargets = perRoute
      .filter((r) => r.rows > 0 && (r.has_cube || r.has_weight) && !(r.has_cube && r.has_weight))
      .sort((a, b) => b.rows - a.rows);

    // Routes with no demand rows in-window but no cube/weight either —
    // populate proactively before P21 starts sending demand.
    const noDemandNoTargets = perRoute
      .filter((r) => r.active && r.rows === 0 && !r.has_cube && !r.has_weight)
      .map((r) => ({ id: r.id, code: r.code, name: r.name, hub: r.hub }));

    return {
      window_days: days,
      totalRows,
      totalCovered,
      overallPct: totalRows === 0 ? null : totalCovered / totalRows,
      perRoute: perRoute.sort((a, b) => b.rows - a.rows),
      missingCubeAndWeight,
      partialTargets,
      noDemandNoTargets,
    };
  });



