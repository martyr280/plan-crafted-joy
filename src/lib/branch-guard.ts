// Legacy server-function gate: every pre-existing authenticated server function runs this
// instead of bare requireSupabaseAuth. Roles and branch binding come from the database (never
// user_metadata); any lookup error fails closed. A branch-bound identity is denied even with
// ZERO roles: an invite-created account (generateLink -> before/failed bm_stage, or revoked)
// is bound through branch_manager_invites, not through a role row.
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { denyLegacyBranchRoles } from "./warehouse-scope";

export type RoleReader = (userId: string) => Promise<string[]>;
export type BindingReader = (userId: string) => Promise<boolean>;

export async function checkLegacyAccessWith(
  readRoles: RoleReader,
  userId: string,
  readBound: BindingReader,
): Promise<void> {
  if (!userId) throw new Error("Authentication required");
  let roles: string[];
  let bound: boolean;
  try {
    [roles, bound] = await Promise.all([readRoles(userId), readBound(userId)]);
  } catch {
    throw new Error("Unable to verify access");
  }
  if (bound !== false) throw new Error("Use the warehouse-scoped branch reports");
  denyLegacyBranchRoles(roles);
}

export const denyLegacyBranchAccess = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ context, next }) => {
    await checkLegacyAccessWith(
      async (uid) => {
        const { data, error } = await context.supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", uid);
        if (error) throw error;
        return (data ?? []).map((r) => String(r.role));
      },
      context.userId,
      async () => {
        const { data, error } = await context.supabase.rpc("current_user_is_branch_bound");
        if (error || typeof data !== "boolean") throw error ?? new Error("bad reply");
        return data;
      },
    );
    return next();
  });
