// E2G Combined Report sync trigger — Supabase Edge Function port of
// src/routes/api/public/sync-e2g.ts.
//
// Auth: send Authorization: Bearer <CRON_SECRET> (or x-cron-secret header).
// Behavior: enqueues an e2g.combined-report bridge job, polls for the
// agent's result, replaces public.e2g_inventory_snapshot wholesale.
//
// Set in supabase/config.toml: [functions.sync-e2g] verify_jwt = false

// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-cron-secret, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkSecret(provided: string | null | undefined, expected: string): boolean {
  return !!provided && timingSafeEqualStr(provided, expected);
}

async function runJob(sb: any, kind: string, payload: any, timeoutMs = 90000) {
  const { data: job, error } = await sb
    .from("p21_bridge_jobs")
    .insert({ kind, payload: payload ?? {} })
    .select("id")
    .single();
  if (error || !job) throw new Error(error?.message ?? "Failed to enqueue job");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: row } = await sb
      .from("p21_bridge_jobs")
      .select("status, result, error")
      .eq("id", job.id)
      .single();
    if (row && (row.status === "done" || row.status === "error")) {
      if (row.status === "error") throw new Error(row.error ?? "Bridge job failed");
      return { jobId: job.id as string, result: row.result };
    }
  }
  throw new Error("Bridge job timed out — is the agent running?");
}

async function applyE2GSnapshot(sb: any): Promise<{ imported: number }> {
  const { result } = await runJob(sb, "e2g.combined-report", {}, 90000);
  const rows = ((result as any)?.rows ?? []) as Array<Record<string, any>>;

  // Replace snapshot regardless of row count.
  await sb
    .from("e2g_inventory_snapshot")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");

  if (rows.length === 0) return { imported: 0 };

  const toInsert = rows.map((r) => {
    const rawDate = r.next_due_date;
    let nextDate: string | null = null;
    if (rawDate) {
      const d = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (!Number.isNaN(d.getTime())) nextDate = d.toISOString().slice(0, 10);
    }
    return {
      item_id: String(r.item_id),
      item_desc: r.item_desc ?? null,
      birm: r.Birm ?? null,
      dallas: r.Dallas ?? null,
      ocala: r.Ocala ?? null,
      total: r.Total ?? null,
      e2g_price: r["E2G Price"] ?? null,
      weight: r.weight ?? null,
      net_weight: r.net_weight ?? null,
      next_due_date: nextDate,
      next_due_in_display: r["Next Due In"] || null,
    };
  });

  for (let i = 0; i < toInsert.length; i += 500) {
    const { error } = await sb.from("e2g_inventory_snapshot").insert(toInsert.slice(i, i + 500));
    if (error) throw new Error(`E2G snapshot insert failed: ${error.message}`);
  }

  return { imported: toInsert.length };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: cors });
  }

  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) {
    return new Response("CRON_SECRET not configured", { status: 500, headers: cors });
  }

  const auth = req.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
  const xCron = req.headers.get("x-cron-secret");
  if (!checkSecret(bearer, secret) && !checkSecret(xCron, secret)) {
    return new Response("unauthorized", { status: 401, headers: cors });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const { imported } = await applyE2GSnapshot(sb);
    return new Response(
      JSON.stringify({ ok: true, imported, syncedAt: new Date().toISOString() }),
      { headers: { ...cors, "content-type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
      { status: 502, headers: { ...cors, "content-type": "application/json" } },
    );
  }
});
