import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { executeDueSchedules } from "@/lib/sql-schedules.server";
import { runSpiffAutomationTick } from "@/lib/spiff.server";

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
          return Response.json({ ok: true, ...result, spiff, ranAt: new Date().toISOString() });
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
