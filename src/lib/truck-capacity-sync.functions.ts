// Server functions for the SharePoint workbook sync (pull only).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function hasAnyRoleSrv(userId: string, roles: string[]): Promise<boolean> {
  for (const role of roles) {
    const { data } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: role as any });
    if (data) return true;
  }
  return false;
}

async function requireLogisticsAdmin(userId: string) {
  const ok = await hasAnyRoleSrv(userId, ["admin", "ops_logistics_admin"]);
  if (!ok) throw new Error("Logistics admin or admin role required");
}

export const getWorkbookSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { connectorStatus, getWorkbookSyncSettings } = await import("./truck-capacity/workbook-sync.server");
    const settings = await getWorkbookSyncSettings();
    const [{ data: state }, { data: logs }, { data: sheetMap }, missingRes] = await Promise.all([
      supabaseAdmin.from("truck_capacity_sync_state").select("*").eq("id", true).maybeSingle(),
      supabaseAdmin.from("truck_capacity_sync_log").select("*").order("started_at", { ascending: false }).limit(10),
      supabaseAdmin.from("truck_capacity_sheet_map").select("sheet_name, route_id, active").limit(2000),
      supabaseAdmin.from("truck_capacity_runs").select("id", { count: "exact", head: true }).eq("missing_from_sheet", true),
    ]);
    return {
      connector: connectorStatus(),
      settings: { enabled: settings.enabled, driveId: settings.driveId, itemId: settings.itemId },
      state: state ?? null,
      logs: logs ?? [],
      sheetMapCount: (sheetMap ?? []).length,
      missingFromSheetCount: missingRes.count ?? 0,
    };
  });

export const syncWorkbookNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ force: z.boolean().optional() }).parse(i ?? {}))
  .handler(async ({ data, context }) => {
    await requireLogisticsAdmin(context.userId);
    const { runWorkbookSync } = await import("./truck-capacity/workbook-sync.server");
    return await runWorkbookSync({ source: "sharepoint", force: data.force ?? true, triggeredBy: context.userId });
  });

export const uploadWorkbookSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i) => z.object({ fileBase64: z.string().min(1) }).parse(i))
  .handler(async ({ data, context }) => {
    await requireLogisticsAdmin(context.userId);
    const { runWorkbookSync } = await import("./truck-capacity/workbook-sync.server");
    return await runWorkbookSync({ source: "upload", fileBase64: data.fileBase64, triggeredBy: context.userId });
  });
