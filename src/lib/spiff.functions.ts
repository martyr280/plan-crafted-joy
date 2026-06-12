// Server-fn wrappers for the SPIFF module (Phase 1).
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { assertAdmin } from "./p21.server";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const GenSchema = z.object({
  quarterLabel: z.string().min(1).max(32),
  dateFrom: DateStr,
  dateTo: DateStr,
});

export const generateSpiffRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => GenSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { generateSpiffRunCore } = await import("./spiff.server");
    return generateSpiffRunCore({ ...data, userId: context.userId });
  });

const RebuildChecksSchema = z.object({ runId: z.string().uuid() });

// Rebuilds spiff_checks for a draft run after the user has reassigned reps
// or toggled included flags. Approved runs are immutable.
export const rebuildSpiffChecks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => RebuildChecksSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: run } = await supabaseAdmin
      .from("spiff_runs")
      .select("id, status")
      .eq("id", data.runId)
      .single();
    if (!run) throw new Error("Run not found");
    if (run.status === "approved" || run.status === "sent_to_ap") {
      throw new Error("Run is approved; create a new run to make changes.");
    }

    const { data: programs } = await supabaseAdmin.from("spiff_programs").select("*");
    const { data: lines } = await supabaseAdmin
      .from("spiff_run_lines")
      .select("program_id, spiff_amount, writing_rep, included, rep_parse_confidence")
      .eq("run_id", data.runId)
      .limit(50000);

    await supabaseAdmin.from("spiff_checks").delete().eq("run_id", data.runId);

    const UNASSIGNED_PAYEE = "(Unassigned)";
    const byProgram = new Map<string, typeof lines>();
    for (const l of lines ?? []) {
      const arr = byProgram.get(l.program_id) ?? [];
      arr.push(l as any);
      byProgram.set(l.program_id, arr as any);
    }

    const inserts: any[] = [];
    for (const p of (programs ?? []) as any[]) {
      const pl = (byProgram.get(p.id) ?? []).filter((l: any) => l.included);
      if (p.payout_mode === "single_check") {
        const amount = pl.reduce((s: number, l: any) => s + Number(l.spiff_amount || 0), 0);
        inserts.push({
          run_id: data.runId,
          program_id: p.id,
          customer_id: p.customer_id,
          payee: p.payee_name ?? p.customer_name,
          amount,
          line_count: pl.length,
          below_minimum: amount < Number(p.min_check_amount),
          status: "pending",
        });
      } else {
        const map = new Map<string, { amount: number; count: number }>();
        for (const l of pl as any[]) {
          const key = l.writing_rep ?? UNASSIGNED_PAYEE;
          const cur = map.get(key) ?? { amount: 0, count: 0 };
          cur.amount += Number(l.spiff_amount || 0);
          cur.count += 1;
          map.set(key, cur);
        }
        for (const [payee, v] of map) {
          inserts.push({
            run_id: data.runId,
            program_id: p.id,
            customer_id: p.customer_id,
            payee,
            amount: v.amount,
            line_count: v.count,
            below_minimum: payee !== UNASSIGNED_PAYEE && v.amount < Number(p.min_check_amount),
            status: "pending",
          });
        }
      }
    }

    if (inserts.length) {
      const { error } = await supabaseAdmin.from("spiff_checks").insert(inserts);
      if (error) throw new Error(error.message);
    }
    return { rebuilt: inserts.length };
  });
