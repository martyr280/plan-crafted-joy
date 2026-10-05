// Legacy server-function gate: every pre-existing authenticated server function runs this
// instead of bare requireSupabaseAuth. Roles come from the database (never user_metadata);
// any lookup error fails closed.
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { denyLegacyBranchRoles } from "./warehouse-scope";

export type RoleReader = (userId: string) => Promise<string[]>;

export async function checkLegacyAccessWith(readRoles: RoleReader, userId: string): Promise<void> {
  if (!userId) throw new Error("Authentication required");
  let roles: string[];
  try {
    roles = await readRoles(userId);
  } catch {
    throw new Error("Unable to verify access");
  }
  denyLegacyBranchRoles(roles);
}

export const denyLegacyBranchAccess = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ context, next }) => {
    await checkLegacyAccessWith(async (uid) => {
      const { data, error } = await context.supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", uid);
      if (error) throw error;
      return (data ?? []).map((r) => String(r.role));
    }, context.userId);
    return next();
  });
