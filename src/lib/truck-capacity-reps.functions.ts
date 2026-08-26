import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Roles that see every route. Anything else falls back to rep scoping. */
const FULL_VIEW_ROLES = [
  "admin",
  "ops_logistics_admin",
  "ops_logistics",
  "ops_orders",
  "ops_reports",
] as const;

const db = () => supabaseAdmin as any;

async function hasAnyRoleSrv(userId: string, roles: readonly string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireLogisticsAdmin(userId: string) {
  const ok = await hasAnyRoleSrv(userId, ["admin", "ops_logistics_admin"]);
  if (!ok) throw new Error("Logistics admin or admin role required");
}

type Mapping = {
  id: string; route_code: string; rep_code: string; rep_name: string | null; active: boolean;
};

async function loadMappings(): Promise<Mapping[]> {
  const { data, error } = await db()
    .from("route_salespeople")
    .select("id, route_code, rep_code, rep_name, active")
    .order("route_code", { ascending: true })
    .order("rep_code", { ascending: true })
    .limit(10000);
  if (error) throw new Error(error.message);
  return (data ?? []) as Mapping[];
}

/**
 * Resolve what the caller is allowed to see. `scoped: true` means the user is a
 * salesperson and must only ever see the routes mapped to their rep code —
 * Jimmy's explicit requirement so reps can't benchmark themselves against peers.
 */
export const getTruckRepScope = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const full = await hasAnyRoleSrv(context.userId, FULL_VIEW_ROLES);
    if (full) return { scoped: false as const, repCode: null, repName: null, routeCodes: [] as string[] };

    const { data: profile } = await db()
      .from("profiles").select("sales_rep_code, display_name")
      .eq("id", context.userId).maybeSingle();
    const repCode: string | null = profile?.sales_rep_code
      ? String(profile.sales_rep_code).trim().toUpperCase()
      : null;

    if (!repCode) {
      return { scoped: true as const, repCode: null, repName: profile?.display_name ?? null, routeCodes: [] as string[] };
    }
    const maps = await loadMappings();
    const routeCodes = maps
      .filter((m) => m.active && m.rep_code.toUpperCase() === repCode)
      .map((m) => m.route_code);
    return {
      scoped: true as const,
      repCode,
      repName: maps.find((m) => m.rep_code.toUpperCase() === repCode)?.rep_name ?? profile?.display_name ?? null,
      routeCodes: Array.from(new Set(routeCodes)),
    };
  });

export const listRouteSalespeople = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ mappings: await loadMappings() }));

/**
 * Fallback rep list for the picker when the P21 bridge is unavailable:
 * whatever rep codes we already know about locally.
 */
export const listKnownRepCodes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const out = new Map<string, string | null>();
    const { data: profiles } = await db()
      .from("profiles").select("sales_rep_code, display_name").not("sales_rep_code", "is", null).limit(5000);
    for (const p of profiles ?? []) {
      const code = String(p.sales_rep_code ?? "").trim().toUpperCase();
      if (code) out.set(code, p.display_name ?? null);
    }
    const maps = await loadMappings();
    for (const m of maps) if (!out.get(m.rep_code)) out.set(m.rep_code, m.rep_name ?? null);
    return {
      reps: Array.from(out.entries())
        .map(([rep_code, rep_name]) => ({ rep_code, rep_name }))
        .sort((a, b) => a.rep_code.localeCompare(b.rep_code)),
    };
  });

/** Replace the full salesperson set for one route. */
export const setRouteSalespeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    route_code: z.string().min(1).max(64),
    reps: z.array(z.object({
      rep_code: z.string().min(1).max(64),
      rep_name: z.string().max(200).nullable().optional(),
    })).max(50),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await requireLogisticsAdmin(context.userId);
    const routeCode = data.route_code.trim();
    const reps = data.reps
      .map((r) => ({ rep_code: r.rep_code.trim().toUpperCase(), rep_name: r.rep_name?.trim() || null }))
      .filter((r) => r.rep_code);

    const { error: delErr } = await db().from("route_salespeople").delete().eq("route_code", routeCode);
    if (delErr) throw new Error(delErr.message);
    if (reps.length > 0) {
      const { error } = await db().from("route_salespeople")
        .upsert(reps.map((r) => ({ route_code: routeCode, ...r, active: true })), { onConflict: "route_code,rep_code" });
      if (error) throw new Error(error.message);
    }
    return { ok: true, count: reps.length };
  });

/**
 * Paste import: one pair per line, `route_code, rep_code[, rep name]`.
 * Tab, comma, semicolon and pipe all work as separators.
 */
export const importRouteSalespeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    text: z.string().max(200000),
    replaceAll: z.boolean().optional(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await requireLogisticsAdmin(context.userId);

    const { data: routes } = await db().from("truck_capacity_routes").select("code").limit(5000);
    const knownCodes = new Set<string>((routes ?? []).map((r: any) => String(r.code).toUpperCase()));

    const rows: Array<{ route_code: string; rep_code: string; rep_name: string | null; active: boolean }> = [];
    const errors: string[] = [];
    const lines = data.text.split(/\r?\n/);
    for (const [idx, raw] of lines.entries()) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/[\t,;|]/).map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts[0] && /^route[_ ]?code$/i.test(parts[0])) continue; // header
      if (parts.length < 2) { errors.push(`Line ${idx + 1}: expected "route_code, rep_code"`); continue; }
      const routeCode = parts[0]!;
      const repCode = parts[1]!.toUpperCase();
      const repName = parts.slice(2).join(" ") || null;
      const match = knownCodes.has(routeCode.toUpperCase());
      if (!match) { errors.push(`Line ${idx + 1}: unknown route code "${routeCode}"`); continue; }
      rows.push({ route_code: routeCode, rep_code: repCode, rep_name: repName, active: true });
    }

    if (data.replaceAll) {
      const { error } = await db().from("route_salespeople").delete().neq("route_code", "\u0000");
      if (error) throw new Error(error.message);
    }
    let inserted = 0;
    if (rows.length > 0) {
      const { error } = await db().from("route_salespeople")
        .upsert(rows, { onConflict: "route_code,rep_code" });
      if (error) throw new Error(error.message);
      inserted = rows.length;
    }
    return { inserted, skipped: errors.length, errors: errors.slice(0, 50) };
  });

export const deleteRouteSalesperson = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireLogisticsAdmin(context.userId);
    const { error } = await db().from("route_salespeople").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* =========================== UNDERFILLED REPORT =========================== */

function weekStartOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

/**
 * Persistently underfilled routes: average utilization below `threshold` over
 * the window AND below threshold in at least `minWeeksBelow` of the weeks that
 * actually have runs. A single bad week is noise; repeat offenders are the
 * conversation Jimmy wants to have with a rep.
 */
export const getUnderfilledRoutes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    weeks: z.number().int().min(1).max(52).optional(),
    threshold: z.number().min(0.05).max(1).optional(),
    minWeeksBelow: z.number().int().min(1).max(52).optional(),
    viewAsRep: z.string().max(64).nullable().optional(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    const weeks = data.weeks ?? 4;
    const threshold = data.threshold ?? 0.6;
    const minWeeksBelow = Math.min(data.minWeeksBelow ?? 3, weeks);

    // Window: `weeks` Sunday-anchored weeks ending with the current week.
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const currentSunday = new Date(todayUtc);
    currentSunday.setUTCDate(currentSunday.getUTCDate() - currentSunday.getUTCDay());
    const weekStarts: string[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const d = new Date(currentSunday);
      d.setUTCDate(d.getUTCDate() - i * 7);
      weekStarts.push(d.toISOString().slice(0, 10));
    }
    const from = weekStarts[0]!;

    const full = await hasAnyRoleSrv(context.userId, FULL_VIEW_ROLES);
    const maps = await loadMappings();

    let scopeRepCode: string | null = null;
    if (!full) {
      const { data: profile } = await db().from("profiles").select("sales_rep_code").eq("id", context.userId).maybeSingle();
      scopeRepCode = profile?.sales_rep_code ? String(profile.sales_rep_code).trim().toUpperCase() : null;
      if (!scopeRepCode) {
        return {
          weeks, threshold, minWeeksBelow, weekStarts, scoped: true,
          repCode: null, rows: [], allRows: [],
          coverage: {
            weeksInWindow: weekStarts.length, weeksWithData: 0, routesWithRuns: 0, routesInScope: 0,
            latestRunDate: null as string | null, latestRunDateAnyTime: null as string | null,
            insufficient: true,
          },
          kpis: { underfilledCount: 0, wastedCapacity: 0, routesEvaluated: 0 },
        };
      }

    } else if (data.viewAsRep) {
      scopeRepCode = data.viewAsRep.trim().toUpperCase();
    }

    const { data: routes, error: rErr } = await db()
      .from("truck_capacity_routes")
      .select("id, code, name, hub, active, sort_order")
      .order("hub", { ascending: true }).order("sort_order", { ascending: true }).limit(2000);
    if (rErr) throw new Error(rErr.message);

    const repsByRoute = new Map<string, Mapping[]>();
    for (const m of maps) {
      if (!m.active) continue;
      const key = m.route_code.toUpperCase();
      repsByRoute.set(key, [...(repsByRoute.get(key) ?? []), m]);
    }

    let scopedRoutes = (routes ?? []).filter((r: any) => r.active);
    if (scopeRepCode) {
      scopedRoutes = scopedRoutes.filter((r: any) =>
        (repsByRoute.get(String(r.code).toUpperCase()) ?? []).some((m) => m.rep_code.toUpperCase() === scopeRepCode));
    }
    const allowedIds = new Set(scopedRoutes.map((r: any) => r.id));

    const { data: runs, error: runErr } = await db()
      .from("truck_capacity_runs")
      .select("route_id, run_date, capacity_frac")
      .gte("run_date", from)
      .limit(100000);
    if (runErr) throw new Error(runErr.message);

    // routeId → weekStart → { sum, n }
    const acc = new Map<string, Map<string, { sum: number; n: number }>>();
    for (const r of runs ?? []) {
      if (!allowedIds.has(r.route_id)) continue;
      const wk = weekStartOf(r.run_date);
      if (!weekStarts.includes(wk)) continue;
      const per = acc.get(r.route_id) ?? new Map();
      const cell = per.get(wk) ?? { sum: 0, n: 0 };
      cell.sum += Number(r.capacity_frac); cell.n += 1;
      per.set(wk, cell); acc.set(r.route_id, per);
    }

    const rows = scopedRoutes.map((r: any) => {
      const per = acc.get(r.id);
      const series = weekStarts.map((w) => {
        const c = per?.get(w);
        return { week: w, value: c && c.n > 0 ? c.sum / c.n : null, runs: c?.n ?? 0 };
      });
      const withData = series.filter((s) => s.value != null) as Array<{ week: string; value: number; runs: number }>;
      const avg = withData.length ? withData.reduce((s, x) => s + x.value, 0) / withData.length : null;
      const weeksBelow = withData.filter((x) => x.value < threshold).length;
      const worst = withData.length
        ? withData.reduce((a, b) => (b.value < a.value ? b : a))
        : null;
      const latest = withData.length ? withData[withData.length - 1]! : null;
      const wasted = withData.reduce((s, x) => s + Math.max(0, threshold - x.value), 0);
      const flagged = avg != null && avg < threshold && weeksBelow >= minWeeksBelow;
      return {
        route_id: r.id, code: r.code, name: r.name, hub: r.hub,
        reps: (repsByRoute.get(String(r.code).toUpperCase()) ?? [])
          .map((m) => ({ rep_code: m.rep_code, rep_name: m.rep_name })),
        avg, weeksBelow, weeksWithData: withData.length,
        worst, latest, series, wasted, flagged,
      };
    });

    const flaggedRows = rows.filter((r: any) => r.flagged)
      .sort((a: any, b: any) => (a.avg ?? 1) - (b.avg ?? 1));

    // Coverage: how much of the window actually has actuals. Without this the UI
    // cannot tell "nothing is underfilled" apart from "nothing was evaluated".
    const weeksWithData = weekStarts.filter((w) =>
      rows.some((r: any) => r.series.some((s: any) => s.week === w && s.value != null))).length;
    const routesWithRuns = rows.filter((r: any) => r.weeksWithData > 0).length;
    let latestRunDate: string | null = null;
    for (const r of runs ?? []) {
      if (!allowedIds.has(r.route_id)) continue;
      if (!latestRunDate || r.run_date > latestRunDate) latestRunDate = r.run_date;
    }
    // Max(run_date) across ALL history for the allowed routes, so the UI can say
    // how stale the tracker is even when the window is empty.
    const { data: latestAny } = await db()
      .from("truck_capacity_runs")
      .select("run_date, route_id")
      .order("run_date", { ascending: false })
      .limit(500);
    let latestRunDateAnyTime: string | null = null;
    for (const r of latestAny ?? []) {
      if (!allowedIds.has(r.route_id)) continue;
      if (!latestRunDateAnyTime || r.run_date > latestRunDateAnyTime) latestRunDateAnyTime = r.run_date;
    }

    return {
      weeks, threshold, minWeeksBelow, weekStarts,
      scoped: !full || !!data.viewAsRep,
      repCode: scopeRepCode,
      rows: flaggedRows,
      allRows: rows.sort((a: any, b: any) => (a.avg ?? 2) - (b.avg ?? 2)),
      coverage: {
        weeksInWindow: weekStarts.length,
        weeksWithData,
        routesWithRuns,
        routesInScope: rows.length,
        latestRunDate,
        latestRunDateAnyTime,
        insufficient: weeksWithData < minWeeksBelow,
      },
      kpis: {
        underfilledCount: flaggedRows.length,
        wastedCapacity: flaggedRows.reduce((s: number, r: any) => s + r.wasted, 0),
        routesEvaluated: rows.filter((r: any) => r.weeksWithData > 0).length,
      },
    };
  });

