import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const db = () => supabaseAdmin as any;

const MANAGER_ROLES = ["admin", "ops_logistics_admin"] as const;

async function hasAnyRoleSrv(userId: string, roles: readonly string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireManager(userId: string) {
  if (!(await hasAnyRoleSrv(userId, MANAGER_ROLES))) {
    throw new Error("Admin or logistics admin role required");
  }
}

async function repCodeOf(userId: string): Promise<string | null> {
  const { data } = await db().from("profiles").select("sales_rep_code").eq("id", userId).maybeSingle();
  return data?.sales_rep_code ? String(data.sales_rep_code).trim().toUpperCase() : null;
}

const RuleInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(160),
  threshold_pct: z.number().min(1).max(100),
  consecutive_days: z.number().int().min(3).max(4),
  scope: z.enum(["all", "routes"]),
  route_codes: z.array(z.string().max(64)).max(500),
  active: z.boolean(),
  cooldown_days: z.number().int().min(0).max(365),
  channels: z.array(z.enum(["in_app", "email"])).min(1),
  owner_user_id: z.string().uuid().nullable().optional(),
  owner_label: z.string().max(160).nullable().optional(),
  manager_digest: z.boolean(),
  lookback_days: z.number().int().min(3).max(90),
});

/* ------------------------------------------------------------------ rules */

export const listCapacityAlertRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context.userId);
    const { data, error } = await db()
      .from("capacity_alert_rules").select("*").order("created_at", { ascending: true }).limit(500);
    if (error) throw new Error(error.message);
    return { rules: data ?? [] };
  });

export const saveCapacityAlertRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => RuleInput.parse(i))
  .handler(async ({ data, context }) => {
    await requireManager(context.userId);
    const { id, ...fields } = data;
    if (id) {
      const { error } = await db().from("capacity_alert_rules").update(fields).eq("id", id);
      if (error) throw new Error(error.message);
      return { ok: true as const, id };
    }
    const { data: row, error } = await db().from("capacity_alert_rules")
      .insert({ ...fields, created_by: context.userId }).select("id").single();
    if (error) throw new Error(error.message);
    return { ok: true as const, id: row.id as string };
  });

export const deleteCapacityAlertRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    await requireManager(context.userId);
    const { error } = await db().from("capacity_alert_rules").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/* ------------------------------------------------------------- evaluation */

/** Admin "Evaluate now". `dryRun` previews what WOULD fire without writing alerts or sending mail. */
export const evaluateCapacityAlertsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    dryRun: z.boolean().optional(),
    ruleId: z.string().uuid().nullable().optional(),
  }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await requireManager(context.userId);
    const { evaluateCapacityAlerts } = await import("@/lib/capacity-alerts.server");
    try {
      const res = await evaluateCapacityAlerts({
        dryRun: data.dryRun ?? true,
        ruleId: data.ruleId ?? null,
      });
      return {
        ok: true as const,
        dryRun: res.dryRun,
        fired: res.fired,
        evaluatedRules: res.evaluatedRules,
        errors: res.errors,
        decisions: res.decisions.map((d) => ({
          rule_name: d.rule_name,
          route_code: d.route_code,
          route_name: d.route_name,
          fired: d.fired,
          reason: d.reason,
          streak_days: d.streak_days,
          streak_from: d.streak_from,
          streak_to: d.streak_to,
          avg_in_streak: d.avg_in_streak,
          avg_month: d.avg_month,
          avg_quarter: d.avg_quarter,
          avg_year: d.avg_year,
          threshold_pct: d.threshold_pct,
          reps: d.reps,
          emailed: d.emailed ?? [],
        })),
      };
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e), dryRun: data.dryRun ?? true, fired: 0, evaluatedRules: 0, errors: [] as string[], decisions: [] as any[] };
    }
  });

export const listCapacityAlertLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ limit: z.number().int().min(1).max(500).optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await requireManager(context.userId);
    const { data: rows, error } = await db()
      .from("capacity_alert_log").select("*")
      .order("evaluated_at", { ascending: false }).limit(data.limit ?? 200);
    if (error) throw new Error(error.message);
    return { rows: rows ?? [] };
  });

/* ----------------------------------------------------------------- alerts */

/** Alert feed. Managers see everything; salespeople see only their own alerts. */
export const listCapacityAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    status: z.enum(["all", "open", "new", "acknowledged", "resolved"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    const isManager = await hasAnyRoleSrv(context.userId, MANAGER_ROLES);
    const repCode = isManager ? null : await repCodeOf(context.userId);
    if (!isManager && !repCode) {
      return { alerts: [], unread: 0, isManager: false, repCode: null, prefs: null as any };
    }

    let q = db().from("capacity_alerts").select("*").order("fired_at", { ascending: false }).limit(data.limit ?? 200);
    if (!isManager) q = q.contains("rep_codes", [repCode!]);
    const status = data.status ?? "all";
    if (status === "open") q = q.in("status", ["new", "acknowledged"]);
    else if (status !== "all") q = q.eq("status", status);

    const { data: alerts, error } = await q;
    if (error) throw new Error(error.message);

    const unread = (alerts ?? []).filter((a: any) => a.status === "new").length;

    let prefs: any = null;
    if (repCode) {
      const { data: p } = await db().from("capacity_alert_prefs").select("*").eq("rep_code", repCode).maybeSingle();
      prefs = p ?? null;
    }
    return { alerts: alerts ?? [], unread, isManager, repCode, prefs };
  });

export const setCapacityAlertStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    id: z.string().uuid(),
    status: z.enum(["new", "acknowledged", "resolved"]),
  }).parse(i))
  .handler(async ({ data, context }) => {
    const isManager = await hasAnyRoleSrv(context.userId, MANAGER_ROLES);
    const repCode = isManager ? null : await repCodeOf(context.userId);

    const { data: row, error: gErr } = await db()
      .from("capacity_alerts").select("id, rep_codes").eq("id", data.id).maybeSingle();
    if (gErr) throw new Error(gErr.message);
    if (!row) throw new Error("Alert not found");
    if (!isManager) {
      const own = (row.rep_codes ?? []).map((c: string) => c.toUpperCase()).includes(repCode ?? "");
      if (!own) throw new Error("Not authorized for this alert");
    }

    const patch: any = { status: data.status };
    if (data.status === "acknowledged") { patch.acknowledged_by = context.userId; patch.acknowledged_at = new Date().toISOString(); }
    if (data.status === "resolved") { patch.resolved_at = new Date().toISOString(); }
    const { error } = await db().from("capacity_alerts").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/* ------------------------------------------------------------- governance */

export const listCapacityAlertPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context.userId);
    const [{ data: prefs }, { data: maps }] = await Promise.all([
      db().from("capacity_alert_prefs").select("*").order("rep_code", { ascending: true }).limit(5000),
      db().from("route_salespeople").select("rep_code, rep_name, active").limit(10000),
    ]);
    const byCode = new Map<string, { rep_code: string; rep_name: string | null; routes: number }>();
    for (const m of maps ?? []) {
      if (!m.active) continue;
      const code = String(m.rep_code).toUpperCase();
      const cur = byCode.get(code) ?? { rep_code: code, rep_name: m.rep_name ?? null, routes: 0 };
      cur.routes += 1;
      if (!cur.rep_name && m.rep_name) cur.rep_name = m.rep_name;
      byCode.set(code, cur);
    }
    const prefMap = new Map((prefs ?? []).map((p: any) => [String(p.rep_code).toUpperCase(), p]));
    const rows = Array.from(byCode.values()).map((r) => {
      const p: any = prefMap.get(r.rep_code);
      return {
        ...r,
        opted_in: p ? !!p.opted_in : true,
        max_per_week: p ? Number(p.max_per_week) : 3,
        email_override: p?.email_override ?? null,
        has_pref_row: !!p,
      };
    }).sort((a, b) => a.rep_code.localeCompare(b.rep_code));
    return { rows };
  });

export const saveCapacityAlertPref = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({
    rep_code: z.string().min(1).max(64),
    opted_in: z.boolean(),
    max_per_week: z.number().int().min(0).max(50),
    email_override: z.string().email().nullable().optional(),
  }).parse(i))
  .handler(async ({ data, context }) => {
    await requireManager(context.userId);
    const { error } = await db().from("capacity_alert_prefs").upsert({
      rep_code: data.rep_code.trim().toUpperCase(),
      opted_in: data.opted_in,
      max_per_week: data.max_per_week,
      email_override: data.email_override ?? null,
      updated_by: context.userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "rep_code" });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

/** Manager digest recipient list, stored in app_settings under `capacity_alerts`. */
export const getCapacityAlertSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireManager(context.userId);
    const { data } = await db().from("app_settings").select("value").eq("key", "capacity_alerts").maybeSingle();
    return { managerEmails: (data?.value?.managerEmails ?? []) as string[] };
  });

export const saveCapacityAlertSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ managerEmails: z.array(z.string().email()).max(50) }).parse(i))
  .handler(async ({ data, context }) => {
    await requireManager(context.userId);
    const { error } = await db().from("app_settings").upsert({
      key: "capacity_alerts",
      value: { managerEmails: data.managerEmails },
      updated_at: new Date().toISOString(),
    }, { onConflict: "key" });
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
