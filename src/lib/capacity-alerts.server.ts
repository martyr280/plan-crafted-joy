// Capacity Alert engine (server-only).
//
// Client requirement: when a salesperson's truck runs below a utilization
// threshold (default 75%) for N consecutive run-days (3–4), notify that
// salesperson automatically, with context averages (this month / past quarter /
// past 12 months) so the numbers can't be argued with.
//
// Design notes:
//  * "Consecutive days" means consecutive *days that have capacity runs* for
//    that route (routes don't run every calendar day), and the newest of those
//    days must fall inside the rule's lookback window so a route that simply
//    stopped reporting can't hold a stale streak forever.
//  * Every decision — fired or skipped — is written to capacity_alert_log.
//  * Cooldown, per-rep opt-out and per-rep weekly caps are all enforced here
//    and reflected in capacity_alerts.delivery for the manager view.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dateStrInTz } from "@/lib/tz";
import { sendCapacityAlertEmail, sendCapacityDigestEmail } from "@/lib/email/nelson-resend.server";

const db = () => supabaseAdmin as any;

export type AlertRule = {
  id: string;
  name: string;
  threshold_pct: number;
  consecutive_days: number;
  scope: "all" | "routes";
  route_codes: string[];
  active: boolean;
  cooldown_days: number;
  channels: string[];
  owner_user_id: string | null;
  owner_label: string | null;
  manager_digest: boolean;
  lookback_days: number;
};

type Mapping = { route_code: string; rep_code: string; rep_name: string | null; active: boolean };

export type EvaluationDecision = {
  rule_id: string;
  rule_name: string;
  route_id: string;
  route_code: string;
  route_name: string;
  reps: Array<{ rep_code: string; rep_name: string | null; muted: boolean; capped: boolean; email: string | null }>;
  fired: boolean;
  reason: string;
  streak_days: number;
  streak_from: string | null;
  streak_to: string | null;
  avg_in_streak: number | null;
  avg_month: number | null;
  avg_quarter: number | null;
  avg_year: number | null;
  threshold_pct: number;
  alert_id?: string | null;
  emailed?: string[];
  email_error?: string | null;
};

function dayKey(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(d: Date, n: number) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

/** Consecutive-calendar-day check across the sorted (desc) run-day list. */
function isConsecutive(dates: string[]): boolean {
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`);
    const cur = new Date(`${dates[i]}T00:00:00Z`);
    const diff = Math.round((prev.getTime() - cur.getTime()) / 86400000);
    if (diff !== 1) return false;
  }
  return true;
}

export async function listAlertRules(): Promise<AlertRule[]> {
  const { data, error } = await db()
    .from("capacity_alert_rules")
    .select("id, name, threshold_pct, consecutive_days, scope, route_codes, active, cooldown_days, channels, owner_user_id, owner_label, manager_digest, lookback_days")
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []) as AlertRule[];
}

async function loadMappings(): Promise<Mapping[]> {
  const { data, error } = await db()
    .from("route_salespeople").select("route_code, rep_code, rep_name, active").limit(10000);
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m: Mapping) => m.active);
}

async function loadPrefs(): Promise<Map<string, { opted_in: boolean; max_per_week: number; email_override: string | null }>> {
  const { data } = await db()
    .from("capacity_alert_prefs").select("rep_code, opted_in, max_per_week, email_override").limit(5000);
  const m = new Map<string, { opted_in: boolean; max_per_week: number; email_override: string | null }>();
  for (const p of data ?? []) {
    m.set(String(p.rep_code).toUpperCase(), {
      opted_in: !!p.opted_in,
      max_per_week: Number(p.max_per_week ?? 3),
      email_override: p.email_override ?? null,
    });
  }
  return m;
}

async function repEmails(codes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!codes.length) return out;
  const { data } = await db()
    .from("profiles").select("email, sales_rep_code").not("sales_rep_code", "is", null).limit(5000);
  for (const p of data ?? []) {
    const code = String(p.sales_rep_code ?? "").trim().toUpperCase();
    if (code && p.email && !out.has(code)) out.set(code, String(p.email));
  }
  return out;
}

async function managerRecipients(rule: AlertRule): Promise<string[]> {
  const emails = new Set<string>();
  const { data: setting } = await db().from("app_settings").select("value").eq("key", "capacity_alerts").maybeSingle();
  for (const e of (setting?.value?.managerEmails ?? []) as string[]) if (e) emails.add(String(e).trim());
  if (rule.owner_user_id) {
    const { data: owner } = await db().from("profiles").select("email").eq("id", rule.owner_user_id).maybeSingle();
    if (owner?.email) emails.add(String(owner.email));
  }
  if (emails.size === 0) {
    const { data: admins } = await db().from("user_roles").select("user_id").eq("role", "admin").limit(50);
    const ids = (admins ?? []).map((a: any) => a.user_id);
    if (ids.length) {
      const { data: profs } = await db().from("profiles").select("email").in("id", ids).limit(50);
      for (const p of profs ?? []) if (p.email) emails.add(String(p.email));
    }
  }
  return Array.from(emails);
}

/**
 * Evaluate every active rule (or one rule) and optionally fire alerts.
 * `dryRun` computes and logs decisions but writes no alerts and sends no email.
 */
export async function evaluateCapacityAlerts(opts: {
  dryRun?: boolean;
  ruleId?: string | null;
  now?: Date;
  skipLog?: boolean;
} = {}): Promise<{ ok: true; dryRun: boolean; evaluatedRules: number; decisions: EvaluationDecision[]; fired: number; errors: string[] }> {
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? new Date();
  const today = new Date(`${dateStrInTz(now)}T00:00:00Z`);
  const errors: string[] = [];

  let rules = (await listAlertRules()).filter((r) => (opts.ruleId ? r.id === opts.ruleId : r.active));
  if (opts.ruleId) rules = rules.slice(0, 1);
  if (!rules.length) {
    return { ok: true, dryRun, evaluatedRules: 0, decisions: [], fired: 0, errors };
  }

  const { data: routes, error: rErr } = await db()
    .from("truck_capacity_routes")
    .select("id, code, name, hub, active, sort_order")
    .order("hub", { ascending: true }).order("sort_order", { ascending: true }).limit(2000);
  if (rErr) throw new Error(rErr.message);
  const activeRoutes = (routes ?? []).filter((r: any) => r.active);

  // One year of run history powers both the streak check and the context stats.
  const yearAgo = dayKey(addDays(today, -370));
  const { data: runs, error: runErr } = await db()
    .from("truck_capacity_runs").select("route_id, run_date, capacity_frac")
    .gte("run_date", yearAgo).limit(200000);
  if (runErr) throw new Error(runErr.message);

  // routeId → dateKey → mean capacity for that day
  const daily = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const r of runs ?? []) {
    const per = daily.get(r.route_id) ?? new Map();
    const cell = per.get(r.run_date) ?? { sum: 0, n: 0 };
    cell.sum += Number(r.capacity_frac); cell.n += 1;
    per.set(r.run_date, cell); daily.set(r.route_id, per);
  }
  const dayAvg = (routeId: string, d: string) => {
    const c = daily.get(routeId)?.get(d);
    return c && c.n ? c.sum / c.n : null;
  };

  const mappings = await loadMappings();
  const repsByRoute = new Map<string, Mapping[]>();
  for (const m of mappings) {
    const k = m.route_code.toUpperCase();
    repsByRoute.set(k, [...(repsByRoute.get(k) ?? []), m]);
  }
  const routesByRep = new Map<string, string[]>();
  const routeIdByCode = new Map<string, string>();
  for (const r of activeRoutes) routeIdByCode.set(String(r.code).toUpperCase(), r.id);
  for (const m of mappings) {
    const id = routeIdByCode.get(m.route_code.toUpperCase());
    if (!id) continue;
    const key = m.rep_code.toUpperCase();
    routesByRep.set(key, [...(routesByRep.get(key) ?? []), id]);
  }

  const prefs = await loadPrefs();
  const emails = await repEmails(mappings.map((m) => m.rep_code.toUpperCase()));

  const monthStart = dayKey(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
  const quarterStart = dayKey(addDays(today, -90));
  const yearStart = dayKey(addDays(today, -365));

  function avgOver(routeIds: string[], from: string): number | null {
    const vals: number[] = [];
    for (const id of routeIds) {
      const per = daily.get(id);
      if (!per) continue;
      for (const [d, c] of per.entries()) if (d >= from && c.n) vals.push(c.sum / c.n);
    }
    return mean(vals);
  }

  // Recent alert history for cooldown + weekly caps.
  const { data: recentAlerts } = await db()
    .from("capacity_alerts").select("route_code, rep_codes, fired_at")
    .gte("fired_at", addDays(today, -400).toISOString()).limit(20000);
  const lastFiredByRoute = new Map<string, string>();
  const weekCountByRep = new Map<string, number>();
  const weekAgoIso = addDays(today, -7).toISOString();
  for (const a of recentAlerts ?? []) {
    const code = String(a.route_code ?? "").toUpperCase();
    const prev = lastFiredByRoute.get(code);
    if (!prev || a.fired_at > prev) lastFiredByRoute.set(code, a.fired_at);
    if (a.fired_at >= weekAgoIso) {
      for (const rc of (a.rep_codes ?? []) as string[]) {
        const k = String(rc).toUpperCase();
        weekCountByRep.set(k, (weekCountByRep.get(k) ?? 0) + 1);
      }
    }
  }

  const decisions: EvaluationDecision[] = [];
  const digestByRule = new Map<string, EvaluationDecision[]>();

  for (const rule of rules) {
    const threshold = Number(rule.threshold_pct) / 100;
    const need = Number(rule.consecutive_days);
    const lookback = Number(rule.lookback_days ?? 14);
    const scopeCodes = new Set((rule.route_codes ?? []).map((c) => c.toUpperCase()));
    const inScope = rule.scope === "routes"
      ? activeRoutes.filter((r: any) => scopeCodes.has(String(r.code).toUpperCase()))
      : activeRoutes;

    for (const route of inScope) {
      const per = daily.get(route.id);
      const allDays = Array.from(per?.keys() ?? []).sort().reverse();
      const windowFrom = dayKey(addDays(today, -lookback));
      const recentDays = allDays.filter((d) => d >= windowFrom);

      const base = {
        rule_id: rule.id, rule_name: rule.name,
        route_id: route.id, route_code: route.code, route_name: route.name,
        threshold_pct: Number(rule.threshold_pct),
      };
      const routeReps = repsByRoute.get(String(route.code).toUpperCase()) ?? [];
      const statScopeIds = routeReps.length
        ? Array.from(new Set(routeReps.flatMap((m) => routesByRep.get(m.rep_code.toUpperCase()) ?? [route.id])))
        : [route.id];
      const ctx = {
        avg_month: avgOver(statScopeIds, monthStart),
        avg_quarter: avgOver(statScopeIds, quarterStart),
        avg_year: avgOver(statScopeIds, yearStart),
      };

      if (recentDays.length < need) {
        decisions.push({
          ...base, ...ctx, reps: [], fired: false,
          reason: `insufficient_data: ${recentDays.length} run-day(s) in the last ${lookback} days, need ${need}`,
          streak_days: recentDays.length, streak_from: null, streak_to: null, avg_in_streak: null,
        });
        continue;
      }

      const streakDays = recentDays.slice(0, need);
      const values = streakDays.map((d) => dayAvg(route.id, d)!).filter((v) => v != null) as number[];
      const allBelow = values.length === need && values.every((v) => v < threshold);
      const consecutive = isConsecutive(streakDays);
      const avgInStreak = mean(values);
      const streakTo = streakDays[0]!;
      const streakFrom = streakDays[streakDays.length - 1]!;

      if (!consecutive) {
        decisions.push({
          ...base, ...ctx, reps: [], fired: false,
          reason: `not_consecutive: run-days ${streakFrom}..${streakTo} are not on consecutive calendar days`,
          streak_days: need, streak_from: streakFrom, streak_to: streakTo, avg_in_streak: avgInStreak,
        });
        continue;
      }
      if (!allBelow) {
        decisions.push({
          ...base, ...ctx, reps: [], fired: false,
          reason: `above_threshold: at least one of the last ${need} days is at or above ${rule.threshold_pct}%`,
          streak_days: need, streak_from: streakFrom, streak_to: streakTo, avg_in_streak: avgInStreak,
        });
        continue;
      }

      const last = lastFiredByRoute.get(String(route.code).toUpperCase());
      if (last && rule.cooldown_days > 0) {
        const daysSince = (today.getTime() - new Date(last).getTime()) / 86400000;
        if (daysSince < rule.cooldown_days) {
          decisions.push({
            ...base, ...ctx, reps: [], fired: false,
            reason: `cooldown: last alert ${daysSince.toFixed(1)} day(s) ago, cooldown is ${rule.cooldown_days} day(s)`,
            streak_days: need, streak_from: streakFrom, streak_to: streakTo, avg_in_streak: avgInStreak,
          });
          continue;
        }
      }

      const reps = routeReps.map((m) => {
        const code = m.rep_code.toUpperCase();
        const pref = prefs.get(code);
        const muted = pref ? !pref.opted_in : false;
        const cap = pref?.max_per_week ?? 3;
        const capped = (weekCountByRep.get(code) ?? 0) >= cap;
        return {
          rep_code: code, rep_name: m.rep_name, muted, capped,
          email: pref?.email_override ?? emails.get(code) ?? null,
        };
      });

      decisions.push({
        ...base, ...ctx, reps, fired: true,
        reason: `fired: ${need} consecutive run-days below ${rule.threshold_pct}% (${streakFrom}..${streakTo})`,
        streak_days: need, streak_from: streakFrom, streak_to: streakTo, avg_in_streak: avgInStreak,
      });
    }
  }

  let fired = 0;
  for (const d of decisions) {
    if (!d.fired) continue;
    fired += 1;
    if (dryRun) continue;

    const rule = rules.find((r) => r.id === d.rule_id)!;
    const sendEmail = (rule.channels ?? []).includes("email");
    const targets = d.reps.filter((r) => !r.muted && !r.capped && r.email);
    const emailed: string[] = [];

    let alertId: string | null = null;
    try {
      const { data: inserted, error: insErr } = await db().from("capacity_alerts").insert({
        rule_id: d.rule_id,
        route_id: d.route_id,
        route_code: d.route_code,
        route_name: d.route_name,
        rep_codes: d.reps.map((r) => r.rep_code),
        threshold_pct: d.threshold_pct,
        streak_days: d.streak_days,
        streak_from: d.streak_from,
        streak_to: d.streak_to,
        avg_utilization_in_streak: d.avg_in_streak,
        avg_month: d.avg_month,
        avg_quarter: d.avg_quarter,
        avg_year: d.avg_year,
        delivery: {
          channels: rule.channels ?? [],
          muted_reps: d.reps.filter((r) => r.muted).map((r) => r.rep_code),
          capped_reps: d.reps.filter((r) => r.capped).map((r) => r.rep_code),
          missing_email: d.reps.filter((r) => !r.email).map((r) => r.rep_code),
          unmapped_route: d.reps.length === 0,
        },
      }).select("id").single();
      if (insErr) throw new Error(insErr.message);
      alertId = inserted?.id ?? null;
    } catch (e: any) {
      errors.push(`alert insert failed for ${d.route_code}: ${e?.message ?? String(e)}`);
    }
    d.alert_id = alertId;

    if (sendEmail) {
      for (const t of targets) {
        try {
          await sendCapacityAlertEmail(t.email!, {
            repName: t.rep_name ?? t.rep_code,
            routeCode: d.route_code,
            routeName: d.route_name,
            thresholdPct: d.threshold_pct,
            streakDays: d.streak_days,
            streakFrom: d.streak_from ?? "",
            streakTo: d.streak_to ?? "",
            avgInStreak: d.avg_in_streak,
            avgMonth: d.avg_month,
            avgQuarter: d.avg_quarter,
            avgYear: d.avg_year,
          });
          emailed.push(t.email!);
        } catch (e: any) {
          d.email_error = e?.message ?? String(e);
          errors.push(`email to ${t.rep_code} failed: ${d.email_error}`);
        }
      }
    }
    d.emailed = emailed;

    if (alertId && emailed.length) {
      await db().from("capacity_alerts").update({ delivery: { emailed } as any }).eq("id", alertId)
        .then(() => null, () => null);
    }
    // Weekly caps must account for alerts fired earlier in this same pass.
    for (const r of d.reps) weekCountByRep.set(r.rep_code, (weekCountByRep.get(r.rep_code) ?? 0) + 1);
    lastFiredByRoute.set(d.route_code.toUpperCase(), new Date().toISOString());

    if (rule.manager_digest) {
      digestByRule.set(rule.id, [...(digestByRule.get(rule.id) ?? []), d]);
    }

    try {
      await db().from("activity_events").insert({
        event_type: "capacity_alert_fired",
        entity_type: "truck_route",
        entity_id: d.route_code,
        message: `Capacity alert: ${d.route_code} below ${d.threshold_pct}% for ${d.streak_days} consecutive days`,
        metadata: { rule: d.rule_name, reps: d.reps.map((r) => r.rep_code), avg_in_streak: d.avg_in_streak },
      });
    } catch { /* activity logging is best-effort */ }
  }

  // Manager digest: one email per rule covering everything that fired.
  if (!dryRun) {
    for (const [ruleId, items] of digestByRule.entries()) {
      const rule = rules.find((r) => r.id === ruleId)!;
      try {
        const to = await managerRecipients(rule);
        if (to.length) {
          await sendCapacityDigestEmail(to, {
            ruleName: rule.name,
            thresholdPct: Number(rule.threshold_pct),
            rows: items.map((i) => ({
              routeCode: i.route_code,
              routeName: i.route_name,
              reps: i.reps.map((r) => r.rep_code + (r.muted ? " (opted out)" : r.capped ? " (weekly cap)" : "")),
              streakDays: i.streak_days,
              avgInStreak: i.avg_in_streak,
              avgMonth: i.avg_month,
              avgQuarter: i.avg_quarter,
              avgYear: i.avg_year,
            })),
          });
        }
      } catch (e: any) {
        errors.push(`manager digest failed: ${e?.message ?? String(e)}`);
      }
    }
  }

  if (!opts.skipLog) {
    const rows = decisions.map((d) => ({
      rule_id: d.rule_id,
      route_id: d.route_id,
      route_code: d.route_code,
      fired: d.fired && !dryRun,
      dry_run: dryRun,
      reason: d.reason,
      streak_days: d.streak_days,
      alert_id: d.alert_id ?? null,
      values: {
        threshold_pct: d.threshold_pct,
        avg_in_streak: d.avg_in_streak,
        avg_month: d.avg_month,
        avg_quarter: d.avg_quarter,
        avg_year: d.avg_year,
        streak_from: d.streak_from,
        streak_to: d.streak_to,
        reps: d.reps.map((r) => ({ rep_code: r.rep_code, muted: r.muted, capped: r.capped, emailed: (d.emailed ?? []).includes(r.email ?? "") })),
        would_fire: d.fired,
      },
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db().from("capacity_alert_log").insert(rows.slice(i, i + 500));
      if (error) errors.push(`log insert failed: ${error.message}`);
    }
  }

  return { ok: true, dryRun, evaluatedRules: rules.length, decisions, fired: dryRun ? 0 : fired, errors };
}
