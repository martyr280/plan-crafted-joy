import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdmin, runJob } from "./p21.server";
import { computeNextRun } from "./sql-schedules.server";
import { SALES_ANNUALIZED_SQL, REP_DISCOVERY_SQL } from "./sales-annualized-template";


export const listP21SalesReps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { result } = await runJob(
      "sql.select",
      { sql: REP_DISCOVERY_SQL, params: {}, slug: "rep-discovery" },
      60_000,
    );
    const rows = ((result as any)?.rows ?? []) as Array<{
      rep_code: string;
      rep_name: string | null;
      rep_email: string | null;
    }>;
    // Email coverage matters: at NDI only ~8 of 51 reps have an email in P21,
    // so the rest need manually-entered schedule recipients.
    const withEmail = rows.filter((r) => !!r.rep_email).length;
    return { reps: rows, total: rows.length, withEmail, withoutEmail: rows.length - withEmail };
  });


export const seedSalesAnnualizedSchedules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);

    const { result } = await runJob(
      "sql.select",
      { sql: REP_DISCOVERY_SQL, params: {}, slug: "rep-discovery" },
      60_000,
    );
    const reps = ((result as any)?.rows ?? []) as Array<{
      rep_code: string;
      rep_name: string | null;
      rep_email: string | null;
    }>;

    // Existing schedules so we don't double-insert per rep_code.
    const { data: existing } = await supabaseAdmin
      .from("sql_schedules")
      .select("id, name, description, params")
      .limit(2000);
    const existingCodes = new Set<string>(
      (existing ?? [])
        .map((r) => (r.params as any)?.repCode as string | undefined)
        .filter(Boolean) as string[],
    );

    const defaultCron = "0 6 1 * *";
    const defaultTz = "America/Chicago";
    const bcc = ["marty@resolvedynamics.com"];

    const created: Array<{ rep_code: string; rep_name: string; id: string }> = [];
    const skipped: Array<{ rep_code: string; reason: string }> = [];

    for (const r of reps) {
      if (!r.rep_code) {
        skipped.push({ rep_code: "(blank)", reason: "no rep_code" });
        continue;
      }
      if (existingCodes.has(r.rep_code)) {
        skipped.push({ rep_code: r.rep_code, reason: "schedule already exists" });
        continue;
      }
      const repName = (r.rep_name || r.rep_code).trim();
      const recipients = r.rep_email ? [r.rep_email] : [];
      const nextRun = (() => {
        try {
          return computeNextRun(defaultCron, defaultTz).toISOString();
        } catch {
          return null;
        }
      })();

      const insertRow = {
        name: `${repName} Sales Annualized`,
        description: r.rep_email
          ? `Per-rep customer scorecard for ${repName} (${r.rep_code}).`
          : `Per-rep scorecard for ${repName} (${r.rep_code}). NO EMAIL ON FILE in P21 — add a recipient before activating.`,
        sql: SALES_ANNUALIZED_SQL.replace(/__REPCODE__/g, r.rep_code.replace(/'/g, "''")),
        params: { repCode: r.rep_code } as any,
        action: "email" as const,
        recipients: recipients as any,
        bcc_recipients: bcc as any,
        email_subject: `${repName} Sales — {{date}}`,
        schedule_cron: defaultCron,
        timezone: defaultTz,
        active: false, // paused; user reviews + activates each
        next_run_at: nextRun,
        created_by: context.userId,
      };

      const { data, error } = await supabaseAdmin
        .from("sql_schedules")
        .insert(insertRow)
        .select("id")
        .single();
      if (error || !data) {
        skipped.push({ rep_code: r.rep_code, reason: error?.message ?? "insert failed" });
        continue;
      }
      created.push({ rep_code: r.rep_code, rep_name: repName, id: data.id });
    }

    const withEmail = reps.filter((r) => !!r.rep_email).length;
    return {
      reps: reps.length,
      created,
      skipped,
      withEmail,
      withoutEmail: reps.length - withEmail,
    };

  });
