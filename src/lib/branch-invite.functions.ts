// Admin-only warehouse-manager invite preparation and the explicit confirmed invite.
// Saving/cancelling a draft never creates a user, role, mapping or email.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { denyLegacyBranchAccess } from "./branch-guard";
import { WAREHOUSES } from "./warehouse-scope";

async function adminDb(supabase: any, userId: string) {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error("Unable to verify access");
  const roles = (data ?? []).map((r: any) => String(r.role));
  if (!roles.includes("admin") || roles.includes("branch_manager")) throw new Error("Forbidden: admin role required");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

const SAFE_ERRORS = ["invalid_email", "invalid_warehouse", "duplicate_email", "not_editable", "not_found", "in_flight", "request_mismatch", "not_invitable", "forbidden"];
function rpcError(e: any): Error {
  const m = String(e?.message ?? "");
  return new Error(SAFE_ERRORS.find((c) => m.includes(c)) ?? "operation_failed");
}

export const listBranchInvites = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .handler(async ({ context }) => {
    const db = await adminDb(context.supabase, context.userId);
    const { data, error } = await db.from("branch_manager_invites")
      .select("id,email_normalized,display_name,warehouse,status,attempt_count,last_error,sent_at,created_at,updated_at,claim_expires_at")
      .order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error("Unable to load warehouse-manager invites");
    return data ?? [];
  });

export const saveBranchInviteDraft = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((i) => z.object({
    id: z.string().uuid().optional(),
    email: z.string().trim().max(255),
    displayName: z.string().trim().max(255).optional(),
    warehouse: z.enum(WAREHOUSES),
  }).strict().parse(i))
  .handler(async ({ data, context }) => {
    const db = await adminDb(context.supabase, context.userId);
    const { data: id, error } = await db.rpc("bm_save_draft", {
      p_actor: context.userId, p_id: data.id ?? null, p_email: data.email,
      p_display_name: data.displayName ?? null, p_warehouse: data.warehouse,
    });
    if (error) throw rpcError(error);
    return { id: id as string };
  });

export const cancelBranchInvite = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((i) => z.object({ id: z.string().uuid() }).strict().parse(i))
  .handler(async ({ data, context }) => {
    const db = await adminDb(context.supabase, context.userId);
    const { data: status, error } = await db.rpc("bm_cancel", { p_actor: context.userId, p_id: data.id });
    if (error) throw rpcError(error);
    return { status: status as string };
  });

/** The ONLY path that may create an auth account or send a warehouse-manager invite. */
export const confirmBranchInvite = createServerFn({ method: "POST" })
  .middleware([denyLegacyBranchAccess])
  .inputValidator((i) => z.object({
    id: z.string().uuid(),
    requestKey: z.string().uuid(),
    email: z.string().trim().max(255),
    warehouse: z.enum(WAREHOUSES),
    confirm: z.literal(true),
  }).strict().parse(i))
  .handler(async ({ data, context }) => {
    const db = await adminDb(context.supabase, context.userId);
    const { runConfirmedInvite } = await import("./branch-invite");
    const { sendNelsonBranchInviteEmail } = await import("./email/nelson-resend.server");
    const origin = process.env.PUBLIC_APP_URL || undefined;
    const ports = {
      db: {
        claim: async (r: any) => {
          const { data: res, error } = await db.rpc("bm_claim", { p_actor: r.actorId, p_id: r.inviteId, p_request_key: r.requestKey, p_email: r.email, p_warehouse: r.warehouse });
          if (error) throw rpcError(error);
          return res;
        },
        stage: async (id: string, key: string, userId: string) => {
          const { error } = await db.rpc("bm_stage", { p_id: id, p_request_key: key, p_user_id: userId });
          if (error) throw new Error(String(error.message ?? "stage_failed"));
        },
        markSent: async (id: string, key: string) => {
          const { error } = await db.rpc("bm_mark_sent", { p_id: id, p_request_key: key });
          if (error) throw new Error("mark_sent_failed");
        },
        markFailed: async (id: string, key: string, code: string) => {
          const { error } = await db.rpc("bm_mark_failed", { p_id: id, p_request_key: key, p_code: code });
          if (error) throw new Error("mark_failed_failed");
        },
      },
      auth: {
        findUserIdByEmail: async (email: string) => {
          const { data: p, error } = await db.from("profiles").select("id").ilike("email", email).limit(2);
          if (error) throw new Error("lookup_failed");
          if ((p ?? []).length > 1) throw new Error("ambiguous");
          return p?.[0]?.id ?? null;
        },
        generateLink: async (email: string, displayName: string | null, existingUserId: string | null) => {
          const { data: link, error } = await db.auth.admin.generateLink(existingUserId
            ? { type: "magiclink", email, options: { redirectTo: origin ? `${origin}/` : undefined } }
            : { type: "invite", email, options: { redirectTo: origin ? `${origin}/` : undefined, data: displayName ? { display_name: displayName } : undefined } });
          if (error || !link?.properties?.action_link || !link?.user?.id) throw new Error("link_failed");
          return { userId: link.user.id, email: String(link.user.email ?? ""), actionLink: link.properties.action_link };
        },
      },
      mail: { send: (to: string, url: string, key: string, wh: string) => sendNelsonBranchInviteEmail(to, url, key, wh) },
    };
    const outcome = await runConfirmedInvite(
      { actorId: context.userId, inviteId: data.id, requestKey: data.requestKey, email: data.email, warehouse: data.warehouse },
      ports as any,
    );
    await db.from("activity_events").insert({
      event_type: "admin.branch_invite", entity_type: "branch_manager_invite", entity_id: data.id, actor_id: context.userId,
      message: `Warehouse-manager invite ${outcome.status}`,
      metadata: { warehouse: data.warehouse, status: outcome.status, code: (outcome as any).code ?? null },
    });
    return outcome;
  });
