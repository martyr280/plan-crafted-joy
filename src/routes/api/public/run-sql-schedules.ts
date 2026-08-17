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
        // Central wall-clock parts for cron gating (DST-stable).
        const ctParts = (d: Date) => {
          const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", hour: "2-digit", minute: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
          const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
          return { hour: Number(get("hour")), minute: Number(get("minute")), day: Number(get("day")), dow: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday")) };
        };

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
          // Nightly truck-capacity P21 snapshot: run once per day 3:00–3:15 AM Central, DST-stable.
          // Dedup: skip if a demand row already carries a snapshot_at on today's UTC date, so
          // overlapping cron ticks in the window don't double-insert.
          let truckCapacity: any = null;
          const now = new Date();
          const ct = ctParts(now);
          // Dedup guards below compare against the UTC date; at 3–8am Central the
          // UTC date equals the Central date, so they remain correct.
          if (ct.hour === 3 && ct.minute < 15) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const todayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
            const { data: already } = await supabaseAdmin
              .from("truck_capacity_p21_demand")
              .select("id")
              .gte("snapshot_at", todayStart)
              .limit(1);
            if (already && already.length > 0) {
              truckCapacity = { ok: true, skipped: true, reason: "already_ran_today" };
            } else {
              try {
                const orders = await runP21Snapshot({ kind: "orders" });
                let transfers: any = null;
                try { transfers = await runP21Snapshot({ kind: "transfers" }); }
                catch (e: any) { transfers = { ok: false, error: e?.message ?? String(e) }; }
                truckCapacity = { orders, transfers };
              } catch (e: any) { truckCapacity = { ok: false, error: e?.message ?? String(e) }; }
            }
          }

          // Nightly truck-capacity model retrain (dedup-guarded by trained_at ≥ todayUTC).
          let truckCapacityRetrain: any = null;
          if (ct.hour === 3 && ct.minute < 15) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const todayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
            const { data: alreadyRetrained } = await supabaseAdmin
              .from("truck_capacity_model_versions")
              .select("id").gte("trained_at", todayStart).limit(1);
            if (alreadyRetrained && alreadyRetrained.length > 0) {
              truckCapacityRetrain = { ok: true, skipped: true, reason: "already_trained_today" };
            } else {
              try {
                const { trainAndMaybePromote } = await import("@/lib/truck-capacity/train");
                truckCapacityRetrain = await trainAndMaybePromote();
              } catch (e: any) { truckCapacityRetrain = { ok: false, error: e?.message ?? String(e) }; }
            }
          }

          // Monthly Sales Reports run: 1st of the month, 3:00–3:15 AM Central.
          // Dedup-guarded by an existing run in the current calendar month so
          // overlapping cron ticks don't produce duplicate runs.
          let salesReports: any = null;
          if (ct.day === 1 && ct.hour === 3 && ct.minute < 15) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
            const { data: alreadyRan } = await supabaseAdmin
              .from("sales_report_runs")
              .select("id").gte("run_at", monthStart).limit(1);
            if (alreadyRan && alreadyRan.length > 0) {
              salesReports = { ok: true, skipped: true, reason: "already_ran_this_month" };
            } else {
              try {
                const { runSalesReports } = await import("@/lib/sales-reports.server");
                salesReports = await runSalesReports({ triggeredBy: null, now });
              } catch (e: any) { salesReports = { ok: false, error: e?.message ?? String(e) }; }
            }
          }

          // Daily capacity-alert evaluation: 7:00–7:15 AM Central, once per day.
          // Dedup-guarded by a non-dry-run evaluation logged today so overlapping
          // cron ticks can't double-alert a rep.
          let capacityAlerts: any = null;
          if (ct.hour === 7 && ct.minute < 15) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const todayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
            const { data: alreadyEvaluated } = await supabaseAdmin
              .from("capacity_alert_log")
              .select("id").eq("dry_run", false).gte("evaluated_at", todayStart).limit(1);
            if (alreadyEvaluated && alreadyEvaluated.length > 0) {
              capacityAlerts = { ok: true, skipped: true, reason: "already_evaluated_today" };
            } else {
              try {
                const { evaluateCapacityAlerts } = await import("@/lib/capacity-alerts.server");
                const res = await evaluateCapacityAlerts({ dryRun: false, now });
                capacityAlerts = { ok: true, fired: res.fired, evaluatedRules: res.evaluatedRules, errors: res.errors };
              } catch (e: any) { capacityAlerts = { ok: false, error: e?.message ?? String(e) }; }
            }
          }

          // Weekly Driver Warehouse Time sweep: Mondays 8:00–8:15 AM Central.
          // Dedup-guarded by a run already started today so overlapping ticks
          // can't double-sweep. Fully try/caught: it must not starve the rest.
          let driverTime: any = null;
          if (ct.dow === 1 && ct.hour === 8 && ct.minute < 15) {
            try {
              const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
              const todayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
              const { data: alreadySwept } = await supabaseAdmin
                .from("driver_warehouse_runs")
                .select("id").gte("started_at", todayStart).limit(1);
              if (alreadySwept && alreadySwept.length > 0) {
                driverTime = { ok: true, skipped: true, reason: "already_swept_today" };
              } else {
                const { runDriverTimeSweep } = await import("@/lib/driver-time.server");
                driverTime = await runDriverTimeSweep({ now, triggeredBy: null });
              }
            } catch (e: any) { driverTime = { ok: false, error: e?.message ?? String(e) }; }
          }

          // Nightly Charlston Office Furniture website export → partner SFTP.
          // Hour is configurable (app_settings.website_export.cronHourUtc, default 09:00 UTC),
          // gated on the enabled flag, deduped by a non-dry-run started today, and fully
          // try/caught so a bad SFTP night can't starve the other blocks.
          let websiteExport: any = null;
          try {
            const { getWebsiteExportSettings } = await import("@/lib/website-export.server");
            const wes = await getWebsiteExportSettings();
            if (wes.enabled && now.getUTCHours() === wes.cronHourUtc && now.getUTCMinutes() < 15) {
              const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
              const todayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
              const { data: alreadyExported } = await supabaseAdmin
                .from("web_export_runs")
                .select("id").eq("dry_run", false).gte("started_at", todayStart).limit(1);
              if (alreadyExported && alreadyExported.length > 0) {
                websiteExport = { ok: true, skipped: true, reason: "already_exported_today" };
              } else {
                const { runWebsiteExport } = await import("@/lib/website-export.server");
                websiteExport = await runWebsiteExport({ trigger: "cron", triggeredBy: null, now });
              }
            }
          } catch (e: any) { websiteExport = { ok: false, error: e?.message ?? String(e) }; }

          return Response.json({ ok: true, ...result, spiff, truckCapacity, truckCapacityRetrain, salesReports, capacityAlerts, driverTime, websiteExport, ranAt: new Date().toISOString() });



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
