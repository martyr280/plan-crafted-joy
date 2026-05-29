import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { executeDueSchedules } from "@/lib/sql-schedules.server";

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
        if (!secret) return new Response("CRON_SECRET not configured", { status: 500 });

        const auth = request.headers.get("authorization");
        const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
        const xCron = request.headers.get("x-cron-secret");

        if (!checkSecret(bearer, secret) && !checkSecret(xCron, secret)) {
          return new Response("unauthorized", { status: 401 });
        }

        try {
          const result = await executeDueSchedules();
          return Response.json({ ok: true, ...result, ranAt: new Date().toISOString() });
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
