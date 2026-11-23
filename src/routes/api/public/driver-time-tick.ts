import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Driver Time sweep tick: advances the oldest queued/running sweep by small,
// resumable units for at most ~15 s, then returns. Called every minute by
// pg_cron. Returns only run ids, phases and counts — no driver data.
// Auth: the managed cron secret, or the same CRON_SECRET / publishable-key
// check as /api/public/run-sql-schedules (job 3's pattern).

function same(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function authorized(request: Request): Promise<boolean> {
  if (process.env["LOVABLE_CRON_SECRET"] && (await authenticateCronRequest(request)) === null) return true;
  const secret = process.env["CRON_SECRET"];
  const anonKey = process.env["SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_ANON_KEY"];
  const auth = request.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
  const xCron = request.headers.get("x-cron-secret");
  const apikey = request.headers.get("apikey");
  const okBySecret = !!secret && (same(bearer, secret) || same(xCron, secret));
  const okByAnon = !!anonKey && (same(apikey, anonKey) || same(bearer, anonKey));
  return okBySecret || okByAnon;
}

export const Route = createFileRoute("/api/public/driver-time-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await authorized(request))) return new Response("unauthorized", { status: 401 });
        try {
          const { runDriverTimeTick } = await import("@/lib/driver-time/sweep-job.server");
          return Response.json(await runDriverTimeTick());
        } catch (e: any) {
          return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
        }
      },
    },
  },
});
