// P21 Bridge — Supabase Edge Function port of src/routes/api/public/p21-bridge.ts
//
// The TanStack Start route at /api/public/p21-bridge does not run on the
// plan-crafted-joy.lovable.app preview URL (server routes are not exposed).
// Edge Functions are deployed independently and reliably reachable, so we
// run the bridge here instead.
//
// Auth: HMAC-SHA256 over `${ts}.${body}` with the shared P21_BRIDGE_SECRET.
// Header: x-bridge-signature: t=<ms>,v1=<hexsig>
// Replay window: 5 minutes.
//
// Set in supabase/config.toml: [functions.p21-bridge] verify_jwt = false
// (the agent has no Supabase JWT; its own HMAC is the auth.)

// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifySignature(body: string, header: string | null): Promise<{ ok: boolean; reason?: string }> {
  const secret = Deno.env.get("P21_BRIDGE_SECRET");
  if (!secret) return { ok: false, reason: "bridge not configured" };
  if (!header) return { ok: false, reason: "missing signature" };

  const parts = Object.fromEntries(
    header.split(",").map((s) => {
      const i = s.indexOf("=");
      return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
    }),
  );
  const ts = Number(parts.t);
  const sigHex = parts.v1;
  if (!Number.isFinite(ts) || !sigHex) return { ok: false, reason: "bad signature format" };
  if (Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) return { ok: false, reason: "stale signature" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
  const expected = bytesToHex(macBuf);

  if (!timingSafeEqual(new TextEncoder().encode(sigHex), new TextEncoder().encode(expected))) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true };
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function upsertAgent(name: string, version?: string, ip?: string | null): Promise<string> {
  const sb = admin();
  const { data: existing } = await sb.from("p21_bridge_agents").select("id").eq("name", name).maybeSingle();
  if (existing) {
    await sb
      .from("p21_bridge_agents")
      .update({ last_seen_at: new Date().toISOString(), version, ip })
      .eq("id", existing.id);
    return existing.id as string;
  }
  const { data: inserted, error } = await sb
    .from("p21_bridge_agents")
    .insert({ name, version, ip, last_seen_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !inserted) throw new Error(`upsertAgent failed: ${error?.message ?? "no row"}`);
  return inserted.id as string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }

  const bodyText = await req.text();
  const sig = req.headers.get("x-bridge-signature");
  const v = await verifySignature(bodyText, sig);
  if (!v.ok) {
    return new Response(v.reason ?? "unauthorized", { status: 401, headers: cors });
  }

  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return new Response("bad json", { status: 400, headers: cors });
  }

  const { action, agent } = body ?? {};
  if (!agent?.name) return new Response("missing agent", { status: 400, headers: cors });

  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;

  let agentId: string;
  try {
    agentId = await upsertAgent(agent.name, agent.version, ip);
  } catch (e: any) {
    return new Response(`upsert failed: ${e?.message ?? e}`, { status: 500, headers: cors });
  }

  const sb = admin();

  if (action === "heartbeat") {
    return new Response(JSON.stringify({ ok: true, agent_id: agentId }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  if (action === "claim") {
    const limit = Math.min(Math.max(Number(body.limit ?? 5), 1), 25);
    const { data: pending } = await sb
      .from("p21_bridge_jobs")
      .select("id")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    const ids = (pending ?? []).map((r: any) => r.id);
    if (ids.length === 0) {
      return new Response(JSON.stringify({ jobs: [] }), {
        headers: { ...cors, "content-type": "application/json" },
      });
    }
    const { data: claimed } = await sb
      .from("p21_bridge_jobs")
      .update({ status: "claimed", agent_id: agentId, claimed_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "pending")
      .select("id, kind, payload");
    return new Response(JSON.stringify({ jobs: claimed ?? [] }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  if (action === "complete") {
    const { jobId, result, error } = body;
    if (!jobId) return new Response("missing jobId", { status: 400, headers: cors });
    await sb
      .from("p21_bridge_jobs")
      .update({
        status: error ? "error" : "done",
        result: result ?? null,
        error: error ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, "content-type": "application/json" },
    });
  }

  return new Response("unknown action", { status: 400, headers: cors });
});
