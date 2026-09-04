import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const db = () => supabaseAdmin as any;

const VIEWER_ROLES = ["admin", "ops_logistics_admin"] as const;

async function hasAnyRoleSrv(userId: string, roles: readonly string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireViewer(userId: string) {
  if (!(await hasAnyRoleSrv(userId, VIEWER_ROLES))) {
    throw new Error("Admin or logistics-admin role required");
  }
}

export const getWebsiteExportStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireViewer(context.userId);
    const { getWebsiteExportSettings, resolveFilename } = await import("./website-export.server");
    const settings = await getWebsiteExportSettings();
    const { data: runs } = await db()
      .from("web_export_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(50);
    const { data: agents } = await db()
      .from("p21_bridge_agents")
      .select("name, version, last_seen_at")
      .order("last_seen_at", { ascending: false })
      .limit(5);
    return {
      settings,
      nextFilename: resolveFilename(settings.filenamePattern, new Date(), settings.timezone),
      runs: runs ?? [],
      agents: agents ?? [],
    };
  });

export const saveWebsiteExportConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z
      .object({
        enabled: z.boolean().optional(),
        database: z.string().min(1).max(128).optional(),
        procedure: z.string().min(1).max(256).optional(),
        filenamePattern: z.string().min(1).max(200).optional(),
        remoteFolder: z.string().min(1).max(400).optional(),
        delimiter: z.string().min(1).max(1).optional(),
        header: z.boolean().optional(),
        timezone: z.string().min(1).max(64).optional(),
        cronHourUtc: z.number().int().min(0).max(23).optional(),
      })
      .parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    if (!(await hasAnyRoleSrv(context.userId, ["admin"]))) throw new Error("Admin role required");
    const { saveWebsiteExportSettings } = await import("./website-export.server");
    return { settings: await saveWebsiteExportSettings(data) };
  });

export const probeWebsiteExportDeliveryFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) =>
    z.object({ paths: z.array(z.string().min(1).max(400)).max(10).optional() }).parse(i ?? {}),
  )
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { probeWebsiteExportDelivery } = await import("./website-export.server");
    return probeWebsiteExportDelivery(data.paths ?? []);
  });

export const runWebsiteExportNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ dryRun: z.boolean().optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await requireViewer(context.userId);
    const { runWebsiteExport } = await import("./website-export.server");
    return runWebsiteExport({
      trigger: "manual",
      dryRun: !!data.dryRun,
      triggeredBy: context.userId,
    });
  });
