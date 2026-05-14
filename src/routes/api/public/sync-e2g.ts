import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { applyE2GSnapshot } from "@/lib/p21.functions";

// Public webhook for scheduling the E2G Combined Report sync.
// Caller must send `Authorization: Bearer <CRON_SECRET>` (or
// `x-cron-secret: <CRON_SECRET>`) matching the env var.
//
// Example (GitHub Actions, cron-job.org, Supabase pg_cron, etc.):
//   curl -X POST https://plan-crafted-joy.lovable.app/api/public/sync-e2g \
//        -H "Authorization: Bearer $CRON_SECRET"

function checkSecret(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/sync-e2g")({
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
          const { imported } = await applyE2GSnapshot();
          return Response.json({ ok: true, imported, syncedAt: new Date().toISOString() });
        } catch (e: any) {
          return Response.json(
            { ok: false, error: e?.message ?? String(e) },
            { status: 502 }
          );
        }
      },
    },
  },
});
