import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

const EnqueueSchema = z.object({
  kind: z.string().min(1).max(64),
  payload: z.record(z.string(), z.any()).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

export const enqueueP21Job = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => EnqueueSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isAdmin = (roles ?? []).some((r: any) => r.role === "admin");
    if (!isAdmin) throw new Error("Admin role required");

    const { data: job, error } = await supabaseAdmin
      .from("p21_bridge_jobs")
      .insert({ kind: data.kind, payload: data.payload ?? {}, created_by: userId })
      .select("id")
      .single();
    if (error || !job) throw new Error(error?.message ?? "Failed to enqueue job");

    const timeout = data.timeoutMs ?? 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data: row } = await supabaseAdmin
        .from("p21_bridge_jobs")
        .select("status, result, error")
        .eq("id", job.id)
        .single();
      if (row && (row.status === "done" || row.status === "error")) {
        if (row.status === "error") throw new Error(row.error ?? "Bridge job failed");
        return { jobId: job.id, result: row.result };
      }
    }
    throw new Error("Bridge job timed out — is the agent running?");
  });

export const getBridgeStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, supabase } = context;
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userId);
    const isAdmin = (roles ?? []).some((r: any) => r.role === "admin");
    if (!isAdmin) throw new Error("Admin role required");

    const { data: agents } = await supabaseAdmin
      .from("p21_bridge_agents")
      .select("*")
      .order("last_seen_at", { ascending: false });
    const { data: pending } = await supabaseAdmin
      .from("p21_bridge_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    const { data: recent } = await supabaseAdmin
      .from("p21_bridge_jobs")
      .select("id, kind, status, created_at, completed_at, error")
      .order("created_at", { ascending: false })
      .limit(20);
    return { agents: agents ?? [], pendingCount: (pending as any)?.length ?? 0, recent: recent ?? [] };
  });
