// Server functions for the Samsara Route Dispatch UI (build 2).
//
// Read = logistics or admin. Write = admin or ops_logistics_admin.
// Shadow mode is enforced HERE as well as in the UI: a push for a route that is
// not in settings.enabledRouteIds is refused server-side, because a disabled
// Push button is UX, not a security boundary.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { nextCutoff, type RouteCutoff } from "@/lib/truck-capacity/cutoffs";
import { parseSequencePaste } from "@/lib/dispatch/paste";
import { normalizeCity, normalizeState, rankCandidates } from "@/lib/dispatch/address-match";

const db = () => supabaseAdmin as any;

const VIEWER_ROLES = ["admin", "ops_logistics", "ops_logistics_admin"] as const;
const WRITER_ROLES = ["admin", "ops_logistics_admin"] as const;

async function hasAnyRoleSrv(userId: string, roles: readonly string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireViewer(userId: string) {
  if (!(await hasAnyRoleSrv(userId, VIEWER_ROLES))) throw new Error("Logistics or admin role required");
}

async function requireWriter(userId: string) {
  if (!(await hasAnyRoleSrv(userId, WRITER_ROLES))) throw new Error("Admin or logistics admin role required");
}

async function requireAdmin(userId: string) {
  if (!(await hasAnyRoleSrv(userId, ["admin"]))) throw new Error("Admin role required");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- runs board */

export const listDispatchRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);
    const { getDispatchSettings } = await import("@/lib/dispatch.server");
    const settings = await getDispatchSettings();

    const [{ data: routes }, { data: cutoffs }, { data: runs }] = await Promise.all([
      db().from("truck_capacity_routes").select("id, code, name, hub, p21_route_code, pallets_full_truck, active, sort_order").eq("active", true).limit(1000),
      db().from("route_cutoffs").select("*").eq("active", true).limit(2000),
      db().from("dispatch_runs").select("*").gte("run_date", todayIso()).order("run_date", { ascending: true }).limit(1000),
    ]);

    const now = new Date();
    const cutoffsByRoute = new Map<string, RouteCutoff[]>();
    for (const c of (cutoffs ?? []) as RouteCutoff[]) {
      const list = cutoffsByRoute.get(c.route_id) ?? [];
      list.push(c);
      cutoffsByRoute.set(c.route_id, list);
    }

    const rows = (routes ?? []).map((r: any) => {
      const list = cutoffsByRoute.get(r.id) ?? [];
      const next = list.length ? nextCutoff(list, now) : null;
      return {
        routeId: r.id as string,
        code: r.code as string,
        name: r.name as string,
        hub: (r.hub as string) ?? "Unassigned",
        p21RouteCode: r.p21_route_code as string | null,
        palletsFullTruck: r.pallets_full_truck as number | null,
        enabled: (settings.enabledRouteIds ?? []).includes(r.id),
        autoPush: (settings.autoPushRouteIds ?? []).includes(r.id),
        cutoff: next
          ? {
              label: next.label,
              timeLabel: next.timeLabel,
              atUtc: next.atUtc.toISOString(),
              fired: next.atUtc.getTime() <= now.getTime(),
              runDates: next.runDates,
              daysAway: next.daysAway,
            }
          : null,
        runs: (runs ?? [])
          .filter((x: any) => x.route_id === r.id)
          .map((x: any) => ({
            id: x.id as string,
            runDate: x.run_date as string,
            runSeq: x.run_seq as number,
            status: x.status as string,
            stopsTotal: Number(x.stops_total ?? 0),
            stopsHeld: Number(x.stops_held ?? 0),
            ordersTotal: Number(x.orders_total ?? 0),
            estPallets: Number(x.est_pallets ?? 0),
            estCubeFt: Number(x.est_cube_ft ?? 0),
            estWeightLbs: Number(x.est_weight_lbs ?? 0),
            lockAt: x.lock_at as string | null,
            pushedAt: x.pushed_at as string | null,
            samsaraRouteId: x.samsara_route_id as string | null,
            error: x.error as string | null,
          })),
      };
    });

    rows.sort((a: any, b: any) => a.hub.localeCompare(b.hub) || a.code.localeCompare(b.code));
    return { rows, settings, viewAvailable: settings.viewAvailable };
  });

export const getDispatchRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ runId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { data: run } = await db().from("dispatch_runs").select("*").eq("id", data.runId).maybeSingle();
    if (!run) throw new Error("Dispatch run not found");
    const { data: stops } = await db()
      .from("dispatch_stops")
      .select("*")
      .eq("dispatch_run_id", data.runId)
      .order("position", { ascending: true })
      .limit(5000);
    const { data: route } = await db()
      .from("truck_capacity_routes")
      .select("id, code, name, hub, pallets_full_truck")
      .eq("id", run.route_id)
      .maybeSingle();
    const { getDispatchSettings } = await import("@/lib/dispatch.server");
    const settings = await getDispatchSettings();
    return {
      run,
      route,
      stops: stops ?? [],
      enabled: (settings.enabledRouteIds ?? []).includes(String(run.route_id)),
      locked: run.lock_at ? Date.now() >= Date.parse(run.lock_at) : false,
    };
  });

export const buildRunNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ routeId: z.string().uuid(), runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireWriter(context.userId);
    const { buildDispatchPlanForRun } = await import("@/lib/dispatch.server");
    const res = await buildDispatchPlanForRun(data.routeId, data.runDate);
    if (!res.ok) return { ok: false as const, error: res.error };
    return {
      ok: true as const,
      runIds: res.runIds,
      runs: res.plan.runs.map((r) => ({ runDate: r.runDate, ...r.totals })),
    };
  });

export const approveAndPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ runId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireWriter(context.userId);
    const { getDispatchSettings, pushRun } = await import("@/lib/dispatch.server");
    const settings = await getDispatchSettings();
    const { data: run } = await db().from("dispatch_runs").select("route_id, status, lock_at").eq("id", data.runId).maybeSingle();
    if (!run) throw new Error("Dispatch run not found");
    if (!(settings.enabledRouteIds ?? []).includes(String(run.route_id))) {
      return { ok: false as const, error: "Route is in shadow mode — enable it in Dispatch settings before pushing" };
    }
    if (run.lock_at && Date.now() >= Date.parse(run.lock_at)) {
      return { ok: false as const, error: "Run is locked; Samsara is not modified after the lock time" };
    }
    const res = await pushRun(data.runId, context.userId);
    return res.ok ? { ok: true as const, action: res.action, reason: res.reason, samsaraRouteId: res.samsaraRouteId } : { ok: false as const, error: res.error };
  });

export const previewDelta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ runId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { previewRunDelta } = await import("@/lib/dispatch.server");
    return previewRunDelta(data.runId);
  });

export const cancelRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ runId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireWriter(context.userId);
    const { cancelDispatchRun } = await import("@/lib/dispatch.server");
    return cancelDispatchRun(data.runId);
  });

/* --------------------------------------------------------- address queue */

export const listAddressQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);

    const { data: pending } = await db()
      .from("samsara_address_map")
      .select("*")
      .eq("verified", false)
      .order("updated_at", { ascending: false })
      .limit(1000);

    // Holds from recent builds are the other half of the queue: a ship_to that
    // never got a map row at all still needs a human.
    const { data: holds } = await db()
      .from("dispatch_stops")
      .select("p21_ship_to_id, customer_name, customer_id, hold_reason, stop_notes, state, dispatch_run_id")
      .eq("hold", true)
      .order("created_at", { ascending: false })
      .limit(2000);

    const known = new Set((pending ?? []).map((p: any) => String(p.p21_ship_to_id)));
    const extra = new Map<string, any>();
    for (const h of holds ?? []) {
      const key = String(h.p21_ship_to_id ?? "");
      if (!key || known.has(key) || extra.has(key)) continue;
      extra.set(key, {
        id: null,
        p21_ship_to_id: key,
        customer_id: h.customer_id,
        customer_name: h.customer_name,
        raw_addr1: null,
        raw_city: null,
        raw_state: h.state,
        raw_zip: null,
        verified: false,
        samsara_address_id: null,
        match_confidence: null,
        match_method: null,
        notes: h.stop_notes,
        hold_reason: h.hold_reason,
      });
    }

    return { rows: [...(pending ?? []), ...extra.values()] };
  });

export const listSamsaraAddresses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);
    try {
      const { fetchAddresses } = await import("@/lib/samsara/hos.server");
      const rows = await fetchAddresses();
      return { ok: true as const, addresses: rows.map((a) => ({ id: a.id, name: a.name, formattedAddress: a.formattedAddress })) };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e), addresses: [] };
    }
  });

/** Rank existing Samsara addresses against a queue row's raw P21 address. */
export const suggestAddressMatches = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        addr1: z.string().nullish(),
        addr2: z.string().nullish(),
        city: z.string().nullish(),
        state: z.string().nullish(),
        zip: z.string().nullish(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    try {
      const { fetchAddresses } = await import("@/lib/samsara/hos.server");
      const addresses = await fetchAddresses();
      const candidates = addresses.map((a) => {
        const text = String(a.formattedAddress ?? "");
        const parts = text.split(",").map((p) => p.trim());
        return {
          samsaraAddressId: a.id,
          address: {
            addr1: parts[0] ?? text,
            city: parts[1] ?? null,
            state: (parts[2] ?? "").split(" ")[0] ?? null,
            zip: (parts[2] ?? "").split(" ")[1] ?? null,
          },
          name: a.name,
          formattedAddress: a.formattedAddress,
        };
      });
      const ranked = rankCandidates(
        { addr1: data.addr1 ?? null, addr2: data.addr2 ?? null, city: data.city ?? null, state: data.state ?? null, zip: data.zip ?? null },
        candidates as any,
      ).slice(0, 8);
      return {
        ok: true as const,
        candidates: ranked.map((c: any) => ({
          samsaraAddressId: c.samsaraAddressId,
          name: c.name,
          formattedAddress: c.formattedAddress,
          score: c.score,
          method: c.method,
        })),
      };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e), candidates: [] };
    }
  });

export const resolveAddress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        action: z.enum(["confirm", "correct", "create"]),
        p21ShipToId: z.string().min(1),
        samsaraAddressId: z.string().nullish(),
        customerId: z.string().nullish(),
        customerName: z.string().nullish(),
        raw: z
          .object({
            addr1: z.string().nullish(),
            addr2: z.string().nullish(),
            city: z.string().nullish(),
            state: z.string().nullish(),
            zip: z.string().nullish(),
          })
          .optional(),
        latitude: z.number().nullish(),
        longitude: z.number().nullish(),
        radiusMeters: z.number().min(30).max(2000).optional(),
        notes: z.string().nullish(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireWriter(context.userId);

    let samsaraAddressId = data.samsaraAddressId ?? null;
    let method = data.action === "create" ? "created" : data.action === "correct" ? "manual" : "confirmed";

    if (data.action === "create") {
      const raw = data.raw ?? {};
      const formatted = [raw.addr1, raw.addr2, raw.city, [raw.state, raw.zip].filter(Boolean).join(" ")]
        .map((p) => String(p ?? "").trim())
        .filter(Boolean)
        .join(", ");
      if (!formatted) return { ok: false as const, error: "Address text is required to create a Samsara address" };
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
        return { ok: false as const, error: "Latitude and longitude are required (no geocoder is configured)" };
      }
      try {
        const { createAddress } = await import("@/lib/samsara/routes.server");
        const rec = await createAddress({
          name: data.customerName || `P21 ${data.p21ShipToId}`,
          formattedAddress: formatted,
          latitude: data.latitude,
          longitude: data.longitude,
          radiusMeters: data.radiusMeters ?? 150,
          externalIds: { p21ShipTo: String(data.p21ShipToId) },
        });
        samsaraAddressId = String(rec.id);
      } catch (e: any) {
        return { ok: false as const, error: `Samsara address create failed: ${e?.message ?? String(e)}` };
      }
    }

    if (!samsaraAddressId) return { ok: false as const, error: "A Samsara address is required" };

    const { error } = await db()
      .from("samsara_address_map")
      .upsert(
        {
          p21_ship_to_id: String(data.p21ShipToId),
          customer_id: data.customerId ?? null,
          customer_name: data.customerName ?? null,
          raw_addr1: data.raw?.addr1 ?? null,
          raw_addr2: data.raw?.addr2 ?? null,
          raw_city: data.raw?.city ?? null,
          raw_state: data.raw?.state ?? null,
          raw_zip: data.raw?.zip ?? null,
          samsara_address_id: samsaraAddressId,
          match_method: method,
          verified: true,
          verified_at: new Date().toISOString(),
          verified_by: context.userId,
          notes: data.notes ?? null,
        },
        { onConflict: "p21_ship_to_id" },
      );
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, samsaraAddressId };
  });

/* ------------------------------------------------------ sequence template */

export const listSequenceTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ routeId: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { data: rows } = await db()
      .from("route_stop_sequences")
      .select("*")
      .eq("route_id", data.routeId)
      .order("position", { ascending: true })
      .limit(2000);
    return { rows: rows ?? [] };
  });

const templateRowSchema = z.object({
  cityRaw: z.string().min(1),
  state: z.string().min(2).max(2),
  deliveryDowLabel: z.string().min(1),
  isPickup: z.boolean().optional(),
  notes: z.string().nullish(),
});

export const saveSequenceTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ routeId: z.string().uuid(), rows: z.array(templateRowSchema).max(500) }).parse(i))
  .handler(async ({ data, context }) => {
    await requireWriter(context.userId);
    await db().from("route_stop_sequences").delete().eq("route_id", data.routeId);
    if (data.rows.length) {
      const { error } = await db()
        .from("route_stop_sequences")
        .insert(
          data.rows.map((r, i) => ({
            route_id: data.routeId,
            position: i + 1,
            city_norm: normalizeCity(r.cityRaw),
            state: normalizeState(r.state),
            delivery_dow_label: r.deliveryDowLabel,
            is_pickup: Boolean(r.isPickup),
            notes: r.notes ?? null,
          })),
        );
      if (error) return { ok: false as const, error: error.message };
    }
    return { ok: true as const, count: data.rows.length };
  });

/**
 * Preview (and optionally commit) a pasted template. Preview is the default:
 * nothing is written until `commit` is explicitly true, and bad lines are
 * returned so the operator sees exactly what was rejected.
 */
export const importSequencePaste = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ routeId: z.string().uuid(), text: z.string().max(200_000), commit: z.boolean().optional() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const parsed = parseSequencePaste(data.text);
    if (!data.commit) return { ok: true as const, committed: false, ...parsed };
    await requireWriter(context.userId);
    if (parsed.errors.length) {
      return { ok: false as const, committed: false, ...parsed, error: `${parsed.errors.length} line(s) could not be parsed` };
    }
    await db().from("route_stop_sequences").delete().eq("route_id", data.routeId);
    if (parsed.rows.length) {
      const { error } = await db()
        .from("route_stop_sequences")
        .insert(
          parsed.rows.map((r) => ({
            route_id: data.routeId,
            position: r.position,
            city_norm: r.cityNorm,
            state: r.state,
            delivery_dow_label: r.deliveryDowLabel,
            is_pickup: r.isPickup,
          })),
        );
      if (error) return { ok: false as const, committed: false, ...parsed, error: error.message };
    }
    return { ok: true as const, committed: true, ...parsed };
  });

/* ------------------------------------------------------------- settings */

export const getDispatchSettingsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);
    const { getDispatchSettings } = await import("@/lib/dispatch.server");
    return getDispatchSettings();
  });

export const saveDispatchSettingsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        enabledRouteIds: z.array(z.string().uuid()).optional(),
        autoPushRouteIds: z.array(z.string().uuid()).optional(),
        depotDepartLocal: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        stopIncrementMin: z.number().int().min(1).max(240).optional(),
        lockOffset: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        viewName: z.string().min(3).optional(),
        viewAvailable: z.boolean().optional(),
        buildDelayMin: z.number().int().min(0).max(240).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { saveDispatchSettings } = await import("@/lib/dispatch.server");
    return saveDispatchSettings(data);
  });

/* -------------------------------------------------------- driver mapping */

export const listDriverMappings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);
    const { data: rows } = await db().from("dispatch_driver_map").select("*").limit(1000);
    let roster: Array<{ id: string; name: string }> = [];
    let rosterError: string | null = null;
    try {
      const { fetchDrivers } = await import("@/lib/samsara/hos.server");
      roster = (await fetchDrivers()).map((d) => ({ id: d.id, name: d.name }));
    } catch (e: any) {
      rosterError = e?.message ?? String(e);
    }
    return { rows: rows ?? [], roster, rosterError };
  });

export const saveDriverMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        routeId: z.string().uuid(),
        samsaraDriverId: z.string().nullish(),
        driverNameRaw: z.string().nullish(),
        confirmed: z.boolean(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }) => {
    await requireWriter(context.userId);
    const { error } = await db()
      .from("dispatch_driver_map")
      .upsert(
        {
          route_id: data.routeId,
          samsara_driver_id: data.samsaraDriverId ?? null,
          driver_name_raw: data.driverNameRaw ?? null,
          // Unconfirmed mappings are deliberately inert: routes get created
          // unassigned rather than assigned to a guess.
          confirmed: Boolean(data.confirmed && data.samsaraDriverId),
        },
        { onConflict: "route_id" },
      );
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
