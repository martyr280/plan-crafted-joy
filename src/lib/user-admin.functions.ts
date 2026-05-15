import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const APP_ROLES = ["admin", "ops_orders", "ops_ar", "ops_logistics", "ops_reports", "sales_rep"] as const;
type AppRole = (typeof APP_ROLES)[number];

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

async function logActivity(eventType: string, message: string, actorId: string, metadata: Record<string, any> = {}) {
  await supabaseAdmin.from("activity_events").insert({
    event_type: eventType,
    entity_type: "user",
    actor_id: actorId,
    message,
    metadata,
  });
}

export const listManagedUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);

    const [{ data: profiles }, { data: rolesRows }, authList] = await Promise.all([
      supabaseAdmin.from("profiles").select("id,email,display_name").order("email").limit(2000),
      supabaseAdmin.from("user_roles").select("user_id,role").limit(10000),
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);

    const rolesByUser: Record<string, AppRole[]> = {};
    (rolesRows ?? []).forEach((r: any) => {
      rolesByUser[r.user_id] = [...(rolesByUser[r.user_id] ?? []), r.role];
    });

    const authByUser: Record<string, { last_sign_in_at: string | null; banned_until: string | null; invited_at: string | null; email_confirmed_at: string | null }> = {};
    (authList.data?.users ?? []).forEach((u: any) => {
      authByUser[u.id] = {
        last_sign_in_at: u.last_sign_in_at ?? null,
        banned_until: u.banned_until ?? null,
        invited_at: u.invited_at ?? null,
        email_confirmed_at: u.email_confirmed_at ?? null,
      };
    });

    return (profiles ?? []).map((p: any) => ({
      id: p.id,
      email: p.email,
      display_name: p.display_name,
      roles: rolesByUser[p.id] ?? [],
      ...(authByUser[p.id] ?? { last_sign_in_at: null, banned_until: null, invited_at: null, email_confirmed_at: null }),
    }));
  });

export const inviteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      email: z.string().trim().email().max(255),
      roles: z.array(z.enum(APP_ROLES)).max(APP_ROLES.length).default([]),
    }).parse(input)
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);

    const origin = process.env.PUBLIC_APP_URL || undefined;
    const { data: invite, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(data.email, {
      redirectTo: origin ? `${origin}/` : undefined,
    });
    if (error) throw new Error(error.message);

    const newId = invite.user?.id;
    if (newId && data.roles.length) {
      const rows = data.roles.map((role) => ({ user_id: newId, role }));
      await supabaseAdmin.from("user_roles").upsert(rows, { onConflict: "user_id,role", ignoreDuplicates: true });
    }

    await logActivity("admin.invite", `Invited ${data.email}`, context.userId, { email: data.email, roles: data.roles });
    return { ok: true, userId: newId };
  });

export const sendPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ email: z.string().trim().email().max(255) }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const origin = process.env.PUBLIC_APP_URL || undefined;
    const { error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: data.email,
      options: { redirectTo: origin ? `${origin}/` : undefined },
    });
    if (error) throw new Error(error.message);
    await logActivity("admin.password_reset", `Sent password reset to ${data.email}`, context.userId, { email: data.email });
    return { ok: true };
  });

export const revokeAllRoles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ userId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    if (data.userId === context.userId) throw new Error("You cannot revoke your own roles.");
    const { error } = await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    await logActivity("admin.role_revoke_all", `Revoked all roles for user ${data.userId}`, context.userId, { user_id: data.userId });
    return { ok: true };
  });

export const setUserDisabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ userId: z.string().uuid(), disabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    if (data.userId === context.userId) throw new Error("You cannot disable your own account.");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      ban_duration: data.disabled ? "876000h" : "none",
    } as any);
    if (error) throw new Error(error.message);
    await logActivity(
      data.disabled ? "admin.disable" : "admin.enable",
      `${data.disabled ? "Disabled" : "Enabled"} user ${data.userId}`,
      context.userId,
      { user_id: data.userId }
    );
    return { ok: true };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      userId: z.string().uuid(),
      role: z.enum(APP_ROLES),
      enable: z.boolean(),
    }).parse(input)
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    if (data.userId === context.userId && data.role === "admin" && !data.enable) {
      throw new Error("You cannot revoke your own admin role.");
    }
    if (data.enable) {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .upsert([{ user_id: data.userId, role: data.role }], { onConflict: "user_id,role", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      await logActivity("admin.role_grant", `Granted ${data.role}`, context.userId, { user_id: data.userId, role: data.role });
    } else {
      const { error } = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .eq("role", data.role);
      if (error) throw new Error(error.message);
      await logActivity("admin.role_revoke", `Revoked ${data.role}`, context.userId, { user_id: data.userId, role: data.role });
    }
    return { ok: true };
  });

export const listAdminActivity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await supabaseAdmin
      .from("activity_events")
      .select("id,event_type,message,created_at,actor_id,metadata")
      .like("event_type", "admin.%")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
