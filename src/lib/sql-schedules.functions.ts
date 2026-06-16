import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertAdmin, runJob } from "./p21.server";
import {
  computeNextRun,
  executeSchedule,
  resolveOutputColumns,
  validateSelectSql,
} from "./sql-schedules.server";

const RecipientsSchema = z.array(z.string().email()).max(20);
const ParamsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .optional();

const UpsertSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  sql: z.string().min(1).max(20000),
  params: ParamsSchema,
  action: z.enum(["email", "upsert_price_list"]),
  recipients: RecipientsSchema.optional(),
  email_subject: z.string().max(200).optional().nullable(),
  schedule_cron: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64).default("America/New_York"),
  active: z.boolean().default(true),
});

export const listSqlSchedules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await supabaseAdmin
      .from("sql_schedules")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { rows: data ?? [] };
  });

export const upsertSqlSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => UpsertSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);

    if (data.action === "email") {
      if (!data.recipients || data.recipients.length === 0) {
        throw new Error("Email schedules require at least one recipient.");
      }
      validateSelectSql(data.sql);
    }

    // Always validate the cron expression (throws on invalid).
    let nextRun: string;
    try {
      nextRun = computeNextRun(data.schedule_cron, data.timezone).toISOString();
    } catch (e: any) {
      throw new Error(`Invalid cron expression: ${e?.message ?? e}`);
    }

    const payload = {
      name: data.name,
      description: data.description ?? null,
      sql: data.sql,
      params: (data.params ?? {}) as any,
      action: data.action,
      recipients: (data.recipients ?? []) as any,
      email_subject: data.email_subject ?? null,
      schedule_cron: data.schedule_cron,
      timezone: data.timezone,
      active: data.active,
      next_run_at: data.active ? nextRun : null,
    };

    if (data.id) {
      const { error } = await supabaseAdmin
        .from("sql_schedules")
        .update(payload)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }

    const { data: created, error } = await supabaseAdmin
      .from("sql_schedules")
      .insert({ ...payload, created_by: context.userId })
      .select("id")
      .single();
    if (error || !created) throw new Error(error?.message ?? "Insert failed");
    return { id: created.id };
  });

export const deleteSqlSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await supabaseAdmin.from("sql_schedules").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const runSqlScheduleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    return executeSchedule(data.id);
  });

const PreviewSchema = z.object({
  sql: z.string().min(1).max(20000),
  params: ParamsSchema,
  maxRows: z.number().int().min(1).max(500).optional(),
});

export const previewSqlSchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => PreviewSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    validateSelectSql(data.sql);
    const { result } = await runJob(
      "sql.select",
      { sql: data.sql, params: data.params ?? {}, slug: "preview" },
      60_000
    );
    const rows = ((result as any)?.rows ?? []) as any[];
    const columns = resolveOutputColumns(data.sql, rows, ((result as any)?.columns ?? undefined) as string[] | undefined);
    const cap = data.maxRows ?? 100;
    return { rows: rows.slice(0, cap), total: rows.length, columns };
  });
