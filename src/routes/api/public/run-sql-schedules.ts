import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { executeDueSchedules } from "@/lib/sql-schedules.server";
import { runSpiffAutomationTick } from "@/lib/spiff.server";
import { runP21Snapshot } from "@/lib/truck-capacity.server";

function checkSecret(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/run-sql-schedules")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

        const auth = request.headers.get("authorization");
        const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
        const xCron = request.headers.get("x-cron-secret");
        const apikey = request.headers.get("apikey");

        const okBySecret = !!secret && (checkSecret(bearer, secret) || checkSecret(xCron, secret));
        const okByAnon = !!anonKey && (checkSecret(apikey, anonKey) || checkSecret(bearer, anonKey));

        if (!okBySecret && !okByAnon) {
          return new Response("unauthorized", { status: 401 });
        }

        try {
          const result = await executeDueSchedules();
          let spiff: any = null;
          try {
            spiff = await runSpiffAutomationTick(new Date());
          } catch (e: any) {
            spiff = { ran: false, error: e?.message ?? String(e) };
          }
          // Nightly truck-capacity P21 snapshot: run once per day between 07:00–07:15 UTC (~03:00 EDT).
          let truckCapacity: any = null;
          const now = new Date();
          if (now.getUTCHours() === 7 && now.getUTCMinutes() < 15) {
            try { truckCapacity = await runP21Snapshot(); }
            catch (e: any) { truckCapacity = { ok: false, error: e?.message ?? String(e) }; }
          }
          return Response.json({ ok: true, ...result, spiff, truckCapacity, ranAt: new Date().toISOString() });
        } catch (e: any) {
          return Response.json(
            { ok: false, error: e?.message ?? String(e) },
            { status: 500 }
          );
        }
      },
    },
  },
});
