import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin role required");
}

const rangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

type UsageRow = {
  id: string;
  user_id: string;
  event_type: string;
  module: string;
  action: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export const getUsageOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => rangeSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const windowStart = new Date(now - 30 * day).toISOString();
    const rangeFrom = data.from ? new Date(data.from).toISOString() : windowStart;
    const rangeTo = data.to ? new Date(data.to).toISOString() : new Date(now + day).toISOString();

    const earliest = rangeFrom < windowStart ? rangeFrom : windowStart;

    // Pull events in chunks (never rely on the implicit 1000-row cap).
    const events: UsageRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data: chunk, error } = await supabaseAdmin
        .from("usage_events")
        .select("id,user_id,event_type,module,action,created_at,metadata")
        .gte("created_at", earliest)
        .order("created_at", { ascending: false })
        .range(offset, offset + 999);
      if (error) throw new Error(error.message);
      events.push(...((chunk ?? []) as UsageRow[]));
      if (!chunk || chunk.length < 1000) break;
    }

    const [{ data: profiles }, { data: roleRows }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id,email,display_name").limit(5000),
      supabaseAdmin.from("user_roles").select("user_id,role").limit(10000),
    ]);

    const since = (d: number) => new Date(now - d * day).toISOString();
    const inRange = (e: UsageRow) => e.created_at >= rangeFrom && e.created_at <= rangeTo;

    const activeSet = (d: number) =>
      new Set(events.filter((e) => e.created_at >= since(d)).map((e) => e.user_id));

    const moduleCounts: Record<string, number> = {};
    events
      .filter((e) => e.created_at >= since(7) && e.event_type === "module_view")
      .forEach((e) => {
        moduleCounts[e.module] = (moduleCounts[e.module] ?? 0) + 1;
      });
    const topModule = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1])[0];

    const rolesByUser: Record<string, string[]> = {};
    (roleRows ?? []).forEach((r: any) => {
      rolesByUser[r.user_id] = [...(rolesByUser[r.user_id] ?? []), r.role];
    });

    const byUser = (profiles ?? []).map((p: any) => {
      const mine = events.filter((e) => e.user_id === p.id);
      const ranged = mine.filter(inRange);
      const logins30 = mine.filter((e) => e.event_type === "login" && e.created_at >= since(30));
      const lastLogin = mine.filter((e) => e.event_type === "login")[0]?.created_at ?? null;
      const modules = Array.from(
        new Set(mine.filter((e) => e.created_at >= since(30)).map((e) => e.module)),
      ).sort();
      const lastActivity = ranged[0]?.created_at ?? mine[0]?.created_at ?? null;
      const inactive =
        !lastLogin || new Date(lastLogin).getTime() < now - 14 * day;
      return {
        user_id: p.id,
        email: p.email as string | null,
        display_name: p.display_name as string | null,
        roles: rolesByUser[p.id] ?? [],
        last_login: lastLogin,
        logins_30d: logins30.length,
        modules_30d: modules,
        last_activity: lastActivity,
        events_in_range: ranged.length,
        inactive,
        never_logged_in: !lastLogin,
      };
    });

    return {
      summary: {
        active_today: activeSet(1).size,
        active_7d: activeSet(7).size,
        active_30d: activeSet(30).size,
        logins_7d: events.filter((e) => e.event_type === "login" && e.created_at >= since(7)).length,
        top_module_7d: topModule ? { module: topModule[0], count: topModule[1] } : null,
        inactive_users: byUser.filter((u) => u.inactive).length,
      },
      byUser,
      modules: Array.from(new Set(events.map((e) => e.module))).sort(),
    };
  });

export const listUsageEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(50),
        userId: z.string().uuid().optional(),
        eventType: z.enum(["login", "module_view", "feature_action"]).optional(),
        module: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let q = supabaseAdmin
      .from("usage_events")
      .select("id,user_id,event_type,module,action,metadata,created_at", { count: "exact" })
      .order("created_at", { ascending: false });

    if (data.userId) q = q.eq("user_id", data.userId);
    if (data.eventType) q = q.eq("event_type", data.eventType);
    if (data.module) q = q.eq("module", data.module);
    if (data.from) q = q.gte("created_at", new Date(data.from).toISOString());
    if (data.to) q = q.lte("created_at", new Date(data.to).toISOString());

    const start = (data.page - 1) * data.pageSize;
    const { data: rows, count, error } = await q.range(start, start + data.pageSize - 1);
    if (error) throw new Error(error.message);

    const ids = Array.from(new Set((rows ?? []).map((r: any) => r.user_id)));
    const { data: profiles } = ids.length
      ? await supabaseAdmin.from("profiles").select("id,email,display_name").in("id", ids)
      : { data: [] as any[] };
    const byId: Record<string, { email: string | null; display_name: string | null }> = {};
    (profiles ?? []).forEach((p: any) => {
      byId[p.id] = { email: p.email, display_name: p.display_name };
    });

    return {
      total: count ?? 0,
      page: data.page,
      pageSize: data.pageSize,
      rows: (rows ?? []).map((r: any) => ({
        ...r,
        email: byId[r.user_id]?.email ?? null,
        display_name: byId[r.user_id]?.display_name ?? null,
      })),
    };
  });
