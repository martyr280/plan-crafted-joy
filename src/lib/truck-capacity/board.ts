// All-routes Forecast board: one row per active route, answering
// "what runs today/tomorrow and where is capacity right now?".
//
// Reuses computeForecastForRoute (the promoted model / blend / P21-guard path)
// rather than re-implementing the model, batched with a small concurrency cap.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeForecastForRoute } from "./serve";
import {
  nextCutoff, runsWeekend, addDaysISO, localDateIn,
  type RouteCutoff, type NextCutoff,
} from "./cutoffs";

export type BoardCutoff = {
  id: string;
  p21_code: string | null;
  atUtc: string;
  localDate: string;
  timeLabel: string;
  tz: string;
  daysAway: number;
  isToday: boolean;
  isTomorrow: boolean;
  runDates: string[];
  windowFrom: string | null;
  windowTo: string | null;
  label: string;
  runDaysLabel: string | null;
  driverName: string | null;
  notes: string | null;
};

export type BoardRow = {
  route_id: string;
  code: string;
  name: string;
  hub: string;
  sort_order: number;
  cutoff_count: number;
  next_cutoff: BoardCutoff | null;
  /** Target ship date the numbers below describe. */
  target_date: string | null;
  /** P21 demand already on the books for the target run (0..1.25). */
  current: number | null;
  /** Model/blend prediction for the target run. */
  predicted: number | null;
  /** Served value: max(prediction, P21). */
  final: number | null;
  method: string | null;
  mad: number | null;
  last_run: { date: string; capacity_frac: number; driver: string | null } | null;
  runs_weekend: boolean;
  forecast_error: string | null;
};

export type BoardResponse = {
  rows: BoardRow[];
  hubs: string[];
  snapshot_at: string | null;
  snapshot_stale: boolean;
  snapshot_age_hours: number | null;
  generated_at: string;
  routes_without_cutoffs: string[];
};

const HUB_ORDER = ["Dallas", "Birmingham", "Ocala"];
const STALE_HOURS = 36;
const HORIZON_DAYS = 21;
const CONCURRENCY = 4;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function serializeCutoff(n: NextCutoff): BoardCutoff {
  return {
    id: n.cutoff.id,
    p21_code: n.cutoff.p21_code,
    atUtc: n.atUtc.toISOString(),
    localDate: n.localDate,
    timeLabel: n.timeLabel,
    tz: n.cutoff.tz,
    daysAway: n.daysAway,
    isToday: n.isToday,
    isTomorrow: n.isTomorrow,
    runDates: n.runDates,
    windowFrom: n.windowFrom,
    windowTo: n.windowTo,
    label: n.label,
    runDaysLabel: n.cutoff.run_days_label,
    driverName: n.cutoff.driver_name,
    notes: n.cutoff.notes,
  };
}

export async function computeForecastBoard(opts: { now?: Date; routeIds?: string[] } = {}): Promise<BoardResponse> {
  const now = opts.now ?? new Date();

  const [{ data: routesData, error: rErr }, { data: cutoffData, error: cErr }] = await Promise.all([
    supabaseAdmin.from("truck_capacity_routes")
      .select("id, code, name, hub, sort_order, active")
      .eq("active", true)
      .order("hub", { ascending: true })
      .order("sort_order", { ascending: true })
      .limit(500),
    supabaseAdmin.from("route_cutoffs")
      .select("*").eq("active", true).order("sort_order", { ascending: true }).limit(2000),
  ]);
  if (rErr) throw new Error(rErr.message);
  if (cErr) throw new Error(cErr.message);

  let routes = routesData ?? [];
  if (opts.routeIds?.length) {
    const allow = new Set(opts.routeIds);
    routes = routes.filter((r) => allow.has(r.id));
  }
  const routeIds = routes.map((r) => r.id);

  const cutoffsByRoute = new Map<string, RouteCutoff[]>();
  for (const c of (cutoffData ?? []) as unknown as RouteCutoff[]) {
    const list = cutoffsByRoute.get(c.route_id) ?? [];
    list.push({ ...c, run_dows: (c.run_dows ?? []).map(Number) });
    cutoffsByRoute.set(c.route_id, list);
  }

  const todayUtc = now.toISOString().slice(0, 10);
  const windowEnd = addDaysISO(todayUtc, HORIZON_DAYS);

  // Latest P21 demand per (route, ship_date) inside the board window.
  const { data: demand } = await supabaseAdmin
    .from("truck_capacity_p21_demand")
    .select("route_id, ship_date, projected_capacity_frac, snapshot_at")
    .gte("ship_date", addDaysISO(todayUtc, -2))
    .lte("ship_date", windowEnd)
    .order("snapshot_at", { ascending: false })
    .limit(20000);
  const demandLatest = new Map<string, number>();
  let snapshotAt: string | null = null;
  for (const d of demand ?? []) {
    const key = `${d.route_id}|${d.ship_date}`;
    if (!demandLatest.has(key)) demandLatest.set(key, Number(d.projected_capacity_frac ?? 0));
    if (d.snapshot_at && (!snapshotAt || d.snapshot_at > snapshotAt)) snapshotAt = d.snapshot_at;
  }

  // Most recent actual run per route.
  const { data: runs } = await supabaseAdmin
    .from("truck_capacity_runs")
    .select("route_id, run_date, capacity_frac, driver")
    .gte("run_date", addDaysISO(todayUtc, -120))
    .order("run_date", { ascending: false })
    .limit(20000);
  const lastRun = new Map<string, { date: string; capacity_frac: number; driver: string | null }>();
  for (const r of runs ?? []) {
    if (!routeIds.includes(r.route_id)) continue;
    if (lastRun.has(r.route_id)) continue;
    lastRun.set(r.route_id, { date: r.run_date, capacity_frac: Number(r.capacity_frac), driver: r.driver ?? null });
  }

  const rows = await mapLimit(routes, CONCURRENCY, async (route): Promise<BoardRow> => {
    const cutoffs = cutoffsByRoute.get(route.id) ?? [];
    const nc = nextCutoff(cutoffs, now);
    const tz = cutoffs[0]?.tz ?? "America/Chicago";
    const targetDate = nc?.runDates[0] ?? (nc ? addDaysISO(nc.localDate, 1) : null);

    // Current = P21 already booked for the target run day (fallback: max across
    // the whole cutoff window so multi-day runs aren't understated).
    let current: number | null = null;
    if (nc) {
      const dates = nc.runDates.length ? nc.runDates : targetDate ? [targetDate] : [];
      for (const d of dates) {
        const v = demandLatest.get(`${route.id}|${d}`);
        if (v != null) current = current == null ? v : Math.max(current, v);
      }
    }

    let predicted: number | null = null;
    let final: number | null = null;
    let method: string | null = null;
    let mad: number | null = null;
    let forecastError: string | null = null;

    if (targetDate && targetDate <= windowEnd) {
      try {
        const fc = await computeForecastForRoute(route.id, HORIZON_DAYS, "auto");
        const day = fc.days.find((d) => d.date === targetDate)
          ?? fc.days.find((d) => d.date >= (localDateIn(tz, now)));
        if (day) {
          predicted = day.blend ?? day.forecast ?? null;
          final = day.final ?? null;
          method = day.method;
          mad = day.mad ?? null;
        }
      } catch (e: any) {
        forecastError = e?.message ?? "Forecast failed";
      }
    }

    if (final == null && current != null) final = current;

    return {
      route_id: route.id,
      code: route.code,
      name: route.name,
      hub: route.hub,
      sort_order: route.sort_order,
      cutoff_count: cutoffs.length,
      next_cutoff: nc ? serializeCutoff(nc) : null,
      target_date: targetDate,
      current,
      predicted,
      final,
      method,
      mad,
      last_run: lastRun.get(route.id) ?? null,
      runs_weekend: runsWeekend(cutoffs),
      forecast_error: forecastError,
    };
  });

  const ageHours = snapshotAt ? (now.getTime() - new Date(snapshotAt).getTime()) / 3_600_000 : null;

  const hubs = [...new Set(rows.map((r) => r.hub))].sort(
    (a, b) => (HUB_ORDER.indexOf(a) + 1 || 99) - (HUB_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );

  return {
    rows,
    hubs,
    snapshot_at: snapshotAt,
    snapshot_stale: ageHours == null ? true : ageHours > STALE_HOURS,
    snapshot_age_hours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    generated_at: now.toISOString(),
    routes_without_cutoffs: rows.filter((r) => r.cutoff_count === 0).map((r) => r.code),
  };
}
