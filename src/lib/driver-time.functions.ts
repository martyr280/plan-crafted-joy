import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dateStrInTz } from "@/lib/driver-time/tz";
import { actualSchema, validateActual, buildReconciledDrivers, weekday } from "@/lib/driver-time/reconciliation";

const db = () => supabaseAdmin as any;

const VIEWER_ROLES = ["admin", "ops_logistics", "ops_logistics_admin"] as const;

async function hasAnyRoleSrv(userId: string, roles: readonly string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireViewer(userId: string) {
  if (!(await hasAnyRoleSrv(userId, VIEWER_ROLES))) {
    throw new Error("Logistics or admin role required");
  }
}

async function requireAdmin(userId: string) {
  if (!(await hasAnyRoleSrv(userId, ["admin"]))) throw new Error("Admin role required");
}

function mondayOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Same hub ordering the Truck Capacity module uses. Re-declared here rather than
 * imported: the canonical HUB_ORDER lives in a route component
 * (src/routes/_app.truck-capacity.tsx) and in src/lib/truck-capacity/board.ts,
 * and a server function must not pull a route module into its graph.
 */
export const DRIVER_TIME_HUB_ORDER = ["Dallas", "Birmingham", "Ocala"] as const;
export const UNASSIGNED_HUB = "Unassigned warehouse";

function compareHubs(a: string, b: string): number {
  if (a === UNASSIGNED_HUB) return b === UNASSIGNED_HUB ? 0 : 1;
  if (b === UNASSIGNED_HUB) return -1;
  const ia = DRIVER_TIME_HUB_ORDER.indexOf(a as any);
  const ib = DRIVER_TIME_HUB_ORDER.indexOf(b as any);
  return (ia + 1 || 99) - (ib + 1 || 99) || a.localeCompare(b);
}


/* ------------------------------------------------------------------ report */

export const getDriverTimeWeek = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), includeWeekends: z.boolean().default(false) }).parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const isAdmin = await hasAnyRoleSrv(context.userId, ["admin"]);
    const weekStart = mondayOf(data.weekStart ?? dateStrInTz(new Date()));
    const weekEndDate = new Date(`${weekStart}T00:00:00Z`);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + (data.includeWeekends ? 6 : 4));
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    const { data: events, error } = await db()
      .from("driver_warehouse_events")
      .select("*")
      .gte("event_date", weekStart)
      .lte("event_date", weekEnd)
      .order("driver_name", { ascending: true })
      .order("start_ts", { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);

    const { data: overrides, error: overrideError } = await db()
      .from("driver_time_week_overrides")
      .select("*")
      .eq("week_start", weekStart)
      .limit(2000);

    if (overrideError) throw new Error(overrideError.message);
    if ((events?.length ?? 0) >= 5000 || (overrides?.length ?? 0) >= 2000) throw new Error("Report exceeds safe row limit; narrow the window.");
    let rates: any[] = [];
    if (isAdmin) {
      const { data: r } = await db()
        .from("driver_pay_rates")
        .select("driver_id, driver_name, hourly_rate, effective_date")
        .lte("effective_date", weekEnd)
        .order("effective_date", { ascending: false })
        .limit(2000);
      rates = r ?? [];
    }

    const { data: runs } = await db()
      .from("driver_warehouse_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(10);

    const { estimateCost } = await import("@/lib/driver-time/cost");
    const rateFor = (driverId: string) =>
      rates.find((r) => String(r.driver_id) === String(driverId))?.hourly_rate ?? null;
    const paycomFor = (driverId: string) =>
      (overrides ?? []).find((o: any) => String(o.driver_id) === String(driverId))?.paycom_hours ?? null;

    const { getDriverTimeSettings } = await import("@/lib/driver-time.server");
    const settings = await getDriverTimeSettings();
    const { isExcludedDriver } = await import("@/lib/driver-time/detect");
    const scopedEvents = (events ?? []).filter((ev:any) => !isExcludedDriver({id:ev.driver_id,name:ev.driver_name}, settings));
    const driverRows = buildReconciledDrivers(scopedEvents, overrides ?? [], data.includeWeekends).map(b => {
      const flaggedHours = b.flaggedMinutes / 60;
      const paidHours = paycomFor(b.driverId);
      const cost = estimateCost({ driverId:b.driverId,driverName:b.driverName,
        samsaraWeekHours:0,paycomHours:paidHours,flaggedHours,
        hourlyRate:isAdmin ? Number(rateFor(b.driverId) ?? 0) || null : null });
      // This module does not fetch total weekly paid hours. Never label zero
      // as real Samsara hours or infer an overtime multiplier from it.
      if (paidHours == null) { cost.cost = null; cost.multiplier = null; cost.note = "Enter Paycom paid hours to estimate cost"; }
      return {...b,flaggedHours:Math.round(flaggedHours*100)/100,cost};
    });

    // Hub groups in the Truck Capacity order, worst offender first inside a hub.
    const hubGroups = Array.from(new Set(driverRows.map((d) => d.hub)))
      .sort(compareHubs)
      .map((hub) => {
        const list = driverRows
          .filter((d) => d.hub === hub)
          .sort((a, b) => b.flaggedMinutes - a.flaggedMinutes || a.driverName.localeCompare(b.driverName));
        return {
          hub,
          drivers: list,
          flaggedMinutes: list.reduce((s, d) => s + d.flaggedMinutes, 0),
          events: list.reduce((s, d) => s + d.events.length, 0),
        };
      });

    return {
      weekStart,
      weekEnd,
      includeWeekends: data.includeWeekends,
      isAdmin,
      drivers: driverRows,
      hubGroups,
      totals: {
        drivers: driverRows.length,
        events: scopedEvents.length,
        flaggedMinutes: driverRows.reduce((s,d)=>s+d.flaggedMinutes,0),
        officialDrivers: driverRows.filter(d=>d.official != null).length,
        automatedMinutes: driverRows.reduce((s,d)=>s+d.automatedMinutes,0),
        unresolvedMinutes: driverRows.reduce((s,d)=>s+d.unresolvedMinutes,0),
        flaggedHours: Math.round((driverRows.reduce((s, d) => s + d.flaggedMinutes, 0) / 60) * 100) / 100,
        needsReview: scopedEvents.filter((e: any) => e.needs_review && !e.superseded_at && e.status !== "excused").length,
        estimatedCost: driverRows.reduce((s, d) => s + (d.cost.cost ?? 0), 0),
        driversWithoutRate: driverRows.filter((d) => d.cost.hourlyRate === null).length,
      },
      runs: runs ?? [],
    };
  });


export const updateDriverTimeEventStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["new", "reviewed", "excused"]),
        notes: z.string().max(2000).nullable().optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const patch: any = { status: data.status };
    if (data.notes !== undefined) patch.notes = data.notes;
    if (data.status === "new") {
      patch.reviewed_by = null;
      patch.reviewed_at = null;
    } else {
      patch.reviewed_by = context.userId;
      patch.reviewed_at = new Date().toISOString();
    }
    const { error } = await db().from("driver_warehouse_events").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export const setPaycomHours = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        driverId: z.string().min(1),
        weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        paycomHours: z.number().min(0).max(200).nullable(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { error } = await db()
      .from("driver_time_week_overrides")
      .upsert(
        {
          driver_id: data.driverId,
          week_start: data.weekStart,
          paycom_hours: data.paycomHours,
          updated_by: context.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "driver_id,week_start" },
      );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/* ------------------------------------------------------------------- sweep */

export const runDriverTimeSweepNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(i => z.object({weekStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    try {
      const { runDriverTimeSweep } = await import("@/lib/driver-time.server");
      return await runDriverTimeSweep({ triggeredBy: context.userId, weekStart:data.weekStart });
    } catch (e: any) {
      return {
        ok: false as const,
        error: e?.message ?? String(e),
        runId: null,
        weekStart: "",
        weekEnd: "",
        driversScanned: 0,
        eventsFound: 0,
        inserted: 0,
        updated: 0,
        reopened: 0,
        warnings: [] as string[],
      };
    }
  });

/* ---------------------------------------------------------------- settings */

export const getDriverTimeConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);
    const { getDriverTimeSettings } = await import("@/lib/driver-time.server");
    const settings = await getDriverTimeSettings();
    let addresses: any[] = [];
    let drivers: any[] = [];
    let error: string | null = null;
    try {
      const { fetchAddresses, fetchDrivers } = await import("@/lib/samsara/hos.server");
      [addresses, drivers] = await Promise.all([fetchAddresses(), fetchDrivers()]);
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
    return {
      settings,
      addresses: addresses.map((a) => ({ id: a.id, name: a.name, formattedAddress: a.formattedAddress })),
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, status: d.driverActivationStatus })),
      error,
    };
  });

export const saveDriverTimeConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        warehouseAddressIds: z.array(z.string()).max(200).optional(),
        thresholdMinutes: z.number().int().min(5).max(1440).optional(),
        excludedDriverIds: z.array(z.string()).max(500).optional(),
        excludedDriverNamePatterns: z.array(z.string().max(120)).max(100).optional(),
        mergeGapMinutes: z.number().int().min(0).max(120).optional(),
        requireLicense: z.boolean().optional(),
        includeDeactivated: z.boolean().optional(),

      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { saveDriverTimeSettings } = await import("@/lib/driver-time.server");
    return { settings: await saveDriverTimeSettings(data) };
  });

/* --------------------------------------------------------------- pay rates */

export const listDriverPayRates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const { data, error } = await db()
      .from("driver_pay_rates")
      .select("*")
      .order("driver_name", { ascending: true })
      .limit(2000);
    if (error) throw new Error(error.message);
    return { rates: data ?? [] };
  });

/** Paste import: "driver id or name, rate" per line. */
export const importDriverPayRates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        text: z.string().max(50_000),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const effective = data.effectiveDate ?? new Date().toISOString().slice(0, 10);

    let roster: Array<{ id: string; name: string }> = [];
    try {
      const { fetchDrivers } = await import("@/lib/samsara/hos.server");
      roster = (await fetchDrivers()).map((d) => ({ id: d.id, name: d.name }));
    } catch {
      roster = [];
    }

    const rows: any[] = [];
    const unmatched: string[] = [];
    for (const raw of data.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/[,\t;]/).map((p) => p.trim());
      if (parts.length < 2) { unmatched.push(line); continue; }
      const rate = Number(parts[parts.length - 1].replace(/[$\s]/g, ""));
      const key = parts.slice(0, -1).join(" ").trim();
      if (!Number.isFinite(rate) || rate <= 0 || !key) { unmatched.push(line); continue; }
      const match =
        roster.find((d) => d.id === key) ??
        roster.find((d) => d.name.toLowerCase() === key.toLowerCase());
      if (!match && roster.length) { unmatched.push(line); continue; }
      rows.push({
        driver_id: match?.id ?? key,
        driver_name: match?.name ?? key,
        hourly_rate: rate,
        effective_date: effective,
      });
    }

    if (rows.length) {
      const { error } = await db()
        .from("driver_pay_rates")
        .upsert(rows, { onConflict: "driver_id,effective_date" });
      if (error) throw new Error(error.message);
    }
    return { ok: true as const, imported: rows.length, unmatched };
  });

/* ------------------------------------------------------------ diagnostics */

export const getSamsaraDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ lookbackDays: z.number().int().min(1).max(30).optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    try {
      const { runSamsaraDiagnostics } = await import("@/lib/driver-time/diagnostics.server");
      return await runSamsaraDiagnostics({ lookbackDays: data.lookbackDays });
    } catch (e: any) {
      const now = new Date().toISOString();
      return {
        ranAt: now,
        fatalError: e?.message ?? String(e),
        windowStartIso: now,
        windowEndIso: now,
        lookbackDays: data.lookbackDays ?? 8,
        settings: {
          thresholdMinutes: 0,
          mergeGapMinutes: 0,
          warehouseAddressIds: [] as string[],
          excludedDriverNamePatterns: [] as string[],
        },
        probes: [] as Array<{ endpoint: string; ok: boolean; detail: string }>,
        fences: [] as any[],
        statusVocabulary: [] as any[],
        funnel: {
          driversOnRoster: 0,
          driversAfterExclusions: 0,
          segmentsFetched: 0,
          segmentsWithCoords: 0,
          gpsSamples: 0,
          blocksBuilt: 0,
          blocksOverThreshold: 0,
          blocksInsideFence: 0,
          blocksOverThresholdAndInsideFence: 0,
          eventsEmitted: 0,
        },

        drivers: [] as any[],
        warnings: [`Diagnostics failed: ${e?.message ?? String(e)}`],
      };
    }
  });

/** Audited warehouse actuals are independent of Paycom paid hours. */
export const saveWarehouseActual = createServerFn({method:"POST"})
  .middleware([requireSupabaseAuth])
  .inputValidator(i => z.object({driverId:z.string().min(1).max(200),weekStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    actual:actualSchema.nullable(), expectedUpdatedAt:z.string().nullable()}).parse(i))
  .handler(async ({data,context}) => {
    await requireViewer(context.userId);
    const actual = data.actual ? validateActual(data.actual,data.weekStart) : null;
    const payload = {warehouse_actual:actual,updated_by:context.userId,updated_at:new Date().toISOString()};
    // Compare-and-set prevents one reviewer silently overwriting another.
    if (data.expectedUpdatedAt) {
      const {data:changed,error} = await db().from("driver_time_week_overrides").update(payload)
        .eq("driver_id",data.driverId).eq("week_start",data.weekStart).eq("updated_at",data.expectedUpdatedAt).select("id");
      if (error) throw new Error(error.message);
      if (!changed?.length) throw new Error("This week changed. Refresh and review the latest value before saving.");
    } else {
      // A Paycom-only row may exist even when this driver has no events.
      // Updating only a still-null actual preserves those paid-hours fields.
      const {data:changed,error:updateError} = await db().from("driver_time_week_overrides").update(payload)
        .eq("driver_id",data.driverId).eq("week_start",data.weekStart).is("warehouse_actual",null).select("id");
      if (updateError) throw new Error(updateError.message);
      if (!changed?.length) {
        const {error} = await db().from("driver_time_week_overrides").insert({...payload,driver_id:data.driverId,week_start:data.weekStart});
        if (error) throw new Error(error.code === "23505" ? "This week already has an entry. Refresh before saving." : error.message);
      }
    }
    return {ok:true as const};
  });
