// Freeze the served forecast for every active route into
// truck_capacity_forecast_log, so forecast-vs-actual scoring no longer depends
// on someone opening the Forecast tab.
//
// Runs nightly from the cron tick (after the P21 snapshot + retrain) and on
// demand from the Settings tab. Routes are processed sequentially: 36 routes ×
// one heavy computeForecastForRoute each, no 36-way fan-out.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dateStrInTz } from "@/lib/tz";
import { computeForecastForRoute } from "./serve";
import { forecastLogRowsFromDays } from "./forecast-log";

export type FreezeResult = {
  ok: true;
  trigger: "nightly" | "manual";
  made_on: string;
  routes: number;
  rows_attempted: number;
  rows_inserted: number;
  rows_existing: number;
  horizon_days: number;
  model_version_id: string | null;
  promoted: boolean;
  route_errors: Array<{ route_id: string; error: string }>;
  ms: number;
};

async function countRowsForDay(madeOn: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("truck_capacity_forecast_log")
    .select("id", { count: "exact", head: true })
    .eq("made_on", madeOn);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function freezeForecasts(opts: {
  trigger: "nightly" | "manual";
  horizonDays?: number;
  actorId?: string | null;
}): Promise<FreezeResult> {
  const started = Date.now();
  const horizonDays = opts.horizonDays ?? 28;
  const madeOn = dateStrInTz(new Date());

  try {
    const { data: routes, error: routesErr } = await supabaseAdmin
      .from("truck_capacity_routes")
      .select("id, code")
      .eq("active", true)
      .order("code", { ascending: true });
    if (routesErr) throw new Error(routesErr.message);

    const before = await countRowsForDay(madeOn);

    let attempted = 0;
    let modelVersionId: string | null = null;
    let promoted = false;
    const routeErrors: Array<{ route_id: string; error: string }> = [];

    for (const r of routes ?? []) {
      try {
        const res = await computeForecastForRoute(r.id, horizonDays, "auto");
        if (res.version) {
          modelVersionId = res.version.id;
          promoted = !!res.version.promoted;
        }
        const rows = forecastLogRowsFromDays(
          r.id,
          res.days,
          madeOn,
          res.version?.id ?? null,
        );
        if (rows.length === 0) continue;
        attempted += rows.length;
        const { error } = await supabaseAdmin
          .from("truck_capacity_forecast_log")
          .upsert(rows, { onConflict: "route_id,forecast_date,made_on,method", ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      } catch (e: any) {
        routeErrors.push({ route_id: r.id, error: e?.message ?? String(e) });
      }
    }

    const after = await countRowsForDay(madeOn);
    const inserted = Math.max(0, after - before);
    const existing = Math.max(0, attempted - inserted);

    const result: FreezeResult = {
      ok: true,
      trigger: opts.trigger,
      made_on: madeOn,
      routes: (routes ?? []).length,
      rows_attempted: attempted,
      rows_inserted: inserted,
      rows_existing: existing,
      horizon_days: horizonDays,
      model_version_id: modelVersionId,
      promoted,
      route_errors: routeErrors,
      ms: Date.now() - started,
    };

    try {
      await supabaseAdmin.from("activity_events").insert({
        event_type: "truck_capacity.forecasts_frozen",
        entity_type: "truck_capacity_forecast_log",
        actor_id: opts.actorId ?? null,
        message: `Truck Capacity: froze forecasts for ${result.routes} routes (${inserted} rows written, ${existing} already present) — trigger ${opts.trigger}`,
        metadata: {
          trigger: opts.trigger,
          made_on: madeOn,
          routes: result.routes,
          rows_attempted: attempted,
          rows_inserted: inserted,
          rows_existing: existing,
          horizon_days: horizonDays,
          model_version_id: modelVersionId,
          promoted,
          route_errors: routeErrors,
          ms: result.ms,
        },
      });
    } catch { /* best-effort */ }

    return result;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    try {
      await supabaseAdmin.from("activity_events").insert({
        event_type: "truck_capacity.forecasts_freeze_failed",
        entity_type: "truck_capacity_forecast_log",
        actor_id: opts.actorId ?? null,
        message: `Truck Capacity: forecast freeze failed (${opts.trigger}) — ${msg}`,
        metadata: { trigger: opts.trigger, made_on: madeOn, horizon_days: horizonDays, error: msg },
      });
    } catch { /* best-effort */ }
    throw e;
  }
}
