import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
// NOTE: supabaseAdmin is imported dynamically inside the handler so the
// server-only client.server module doesn't leak into the client bundle via
// the route tree. Vite's splitter strips handler bodies (and their dynamic
// imports) but does not tree-shake top-level imports that are only used
// inside them.
//
// This route is functionally superseded by the Supabase Edge Function at
// supabase/functions/p21-bridge/index.ts (the lovable.app host doesn't run
// TanStack server routes reliably). Kept for parity / local testing.

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function verify(body: string, header: string | null): { ok: boolean; reason?: string } {
  const secret = process.env.P21_BRIDGE_SECRET;
  if (!secret) return { ok: false, reason: "bridge not configured" };
  if (!header) return { ok: false, reason: "missing signature" };
  const [tsPart, sigPart] = header.split(",").map((s) => s.split("=")[1] ?? "");
  if (!tsPart || !sigPart) return { ok: false, reason: "bad signature format" };
  const ts = Number(tsPart);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: "stale signature" };
  }
  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

async function upsertAgent(
  supabaseAdmin: any,
  name: string,
  version?: string,
  ip?: string,
): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from("p21_bridge_agents")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (existing) {
    await supabaseAdmin
      .from("p21_bridge_agents")
      .update({ last_seen_at: new Date().toISOString(), version, ip })
      .eq("id", existing.id);
    return existing.id as string;
  }
  const { data: inserted } = await supabaseAdmin
    .from("p21_bridge_agents")
    .insert({ name, version, ip, last_seen_at: new Date().toISOString() })
    .select("id")
    .single();
  return inserted!.id as string;
}

export const Route = createFileRoute("/api/public/p21-bridge")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const bodyText = await request.text();
        const sig = request.headers.get("x-bridge-signature");
        const v = verify(bodyText, sig);
        if (!v.ok) return new Response(v.reason ?? "unauthorized", { status: 401 });

        let body: any;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return new Response("bad json", { status: 400 });
        }

        const { action, agent } = body ?? {};
        if (!agent?.name) return new Response("missing agent", { status: 400 });

        const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? null;
        const agentId = await upsertAgent(supabaseAdmin, agent.name, agent.version, ip ?? undefined);

        if (action === "heartbeat") {
          return Response.json({ ok: true, agent_id: agentId });
        }

        if (action === "claim") {
          const limit = Math.min(Math.max(Number(body.limit ?? 5), 1), 25);
          const { data: pending } = await supabaseAdmin
            .from("p21_bridge_jobs")
            .select("id")
            .eq("status", "pending")
            .order("created_at", { ascending: true })
            .limit(limit);
          const ids = (pending ?? []).map((r: any) => r.id);
          if (ids.length === 0) return Response.json({ jobs: [] });
          const { data: claimed } = await supabaseAdmin
            .from("p21_bridge_jobs")
            .update({ status: "claimed", agent_id: agentId, claimed_at: new Date().toISOString() })
            .in("id", ids)
            .eq("status", "pending")
            .select("id, kind, payload");
          return Response.json({ jobs: claimed ?? [] });
        }

        if (action === "complete") {
          const { jobId, result, error } = body;
          if (!jobId) return new Response("missing jobId", { status: 400 });
          await supabaseAdmin
            .from("p21_bridge_jobs")
            .update({
              status: error ? "error" : "done",
              result: result ?? null,
              error: error ?? null,
              completed_at: new Date().toISOString(),
            })
            .eq("id", jobId);
          return Response.json({ ok: true });
        }

        return new Response("unknown action", { status: 400 });
      },
    },
  },
});
