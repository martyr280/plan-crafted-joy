// Server-only SPIFF generation logic. Pulls real P21 lines via the existing
// agent bridge (`sql.select`), parses writing reps, applies product-scope
// filters, computes per-line spiff, builds payee checks, and persists
// everything under a spiff_runs row.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import {
  SPIFF_LINES_SQL,
  SPIFF_AGING_SQL,
  isInScope,
  type ProductScope,
} from "./spiff/constants";
import { parseWritingRep } from "./spiff/parser";

const LINES_TIMEOUT_MS = 120_000;
const AGING_TIMEOUT_MS = 60_000;
const UNASSIGNED_PAYEE = "(Unassigned)";

type Program = {
  id: string;
  customer_id: string;
  customer_name: string;
  rep_org: string;
  rate: number;
  product_scope: ProductScope;
  exclude_special_orders: boolean;
  payout_mode: "per_writing_rep" | "single_check";
  payee_name: string | null;
  min_check_amount: number;
  notes: string | null;
  active: boolean;
};

type RawLine = {
  order_date: string | null;
  customer_id: string;
  order_no: string | number | null;
  po_no: string | null;
  inv_mast_uid: number | null;
  item_id: string | null;
  item_desc: string | null;
  product_group_id: string | null;
  qty_ordered: number | string | null;
  unit_price: number | string | null;
  extended_price: number | string | null;
  disposition: string | null;
  validation_status: string | null;
  kit: number | null;
};

function num(v: any): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function findOrCreateDraftRun(opts: {
  quarterLabel: string;
  dateFrom: string;
  dateTo: string;
  userId: string;
}): Promise<{ id: string; isNew: boolean }> {
  const { data: existing } = await supabaseAdmin
    .from("spiff_runs")
    .select("id, status")
    .eq("quarter_label", opts.quarterLabel)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing && existing.status === "draft") {
    // Wipe lines/checks for idempotent regeneration.
    await supabaseAdmin.from("spiff_run_lines").delete().eq("run_id", existing.id);
    await supabaseAdmin.from("spiff_checks").delete().eq("run_id", existing.id);
    await supabaseAdmin
      .from("spiff_runs")
      .update({ date_from: opts.dateFrom, date_to: opts.dateTo, totals: {} })
      .eq("id", existing.id);
    return { id: existing.id, isNew: false };
  }

  const { data: created, error } = await supabaseAdmin
    .from("spiff_runs")
    .insert({
      quarter_label: opts.quarterLabel,
      date_from: opts.dateFrom,
      date_to: opts.dateTo,
      status: "draft",
      created_by: opts.userId,
      totals: {},
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Failed to create spiff run");
  return { id: created.id, isNew: true };
}

async function fetchProgramLines(
  program: Program,
  dateFrom: string,
  dateTo: string
): Promise<RawLine[]> {
  const { result } = await runJob(
    "sql.select",
    {
      sql: SPIFF_LINES_SQL,
      params: {
        dateFrom,
        dateTo,
        customerId: program.customer_id,
      },
      slug: `spiff-${program.customer_id}`,
    },
    LINES_TIMEOUT_MS
  );
  const rows = ((result as any)?.rows ?? []) as RawLine[];
  return rows;
}

async function fetchAging(customerIds: string[]): Promise<{
  byCustomer: Record<string, number>;
  error: string | null;
}> {
  if (customerIds.length === 0) return { byCustomer: {}, error: null };
  // sql.select params don't support array expansion → inline as quoted literals.
  // Customer IDs from spiff_programs are trusted (admin-managed seed), but
  // keep a strict whitelist to defang anything weird.
  const safe = customerIds.filter((c) => /^[A-Za-z0-9_-]+$/.test(c));
  const inList = safe.map((c) => `'${c}'`).join(",");
  const sql = SPIFF_AGING_SQL.replace("{customer_ids}", inList);
  try {
    const { result } = await runJob("sql.select", { sql, slug: "spiff-aging" }, AGING_TIMEOUT_MS);
    const rows = ((result as any)?.rows ?? []) as Array<{ customer_id: string; past_due_30: number | string }>;
    const byCustomer: Record<string, number> = {};
    for (const r of rows) byCustomer[String(r.customer_id)] = num(r.past_due_30);
    return { byCustomer, error: null };
  } catch (e: any) {
    return { byCustomer: {}, error: e?.message ?? "aging query failed" };
  }
}

function buildChecksForProgram(
  program: Program,
  lineRows: Array<{
    spiff_amount: number;
    writing_rep: string | null;
    included: boolean;
    rep_parse_confidence: string;
  }>
): Array<{
  program_id: string;
  customer_id: string;
  payee: string;
  amount: number;
  line_count: number;
  below_minimum: boolean;
}> {
  const included = lineRows.filter((l) => l.included);
  if (program.payout_mode === "single_check") {
    const amount = included.reduce((s, l) => s + l.spiff_amount, 0);
    return [
      {
        program_id: program.id,
        customer_id: program.customer_id,
        payee: program.payee_name ?? program.customer_name,
        amount,
        line_count: included.length,
        below_minimum: amount < program.min_check_amount,
      },
    ];
  }
  // per_writing_rep
  const byRep = new Map<string, { amount: number; lines: number }>();
  for (const l of included) {
    const key = l.writing_rep ?? UNASSIGNED_PAYEE;
    const cur = byRep.get(key) ?? { amount: 0, lines: 0 };
    cur.amount += l.spiff_amount;
    cur.lines += 1;
    byRep.set(key, cur);
  }
  return Array.from(byRep.entries()).map(([payee, v]) => ({
    program_id: program.id,
    customer_id: program.customer_id,
    payee,
    amount: v.amount,
    line_count: v.lines,
    below_minimum: payee !== UNASSIGNED_PAYEE && v.amount < program.min_check_amount,
  }));
}

export async function generateSpiffRunCore(opts: {
  quarterLabel: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;   // YYYY-MM-DD (EXCLUSIVE)
  userId: string;
}): Promise<{ runId: string; programsProcessed: number; errors: Record<string, string> }> {
  const { data: programs } = await supabaseAdmin
    .from("spiff_programs")
    .select("*")
    .eq("active", true)
    .order("customer_name");
  const progs = (programs ?? []) as Program[];

  const { id: runId } = await findOrCreateDraftRun(opts);

  const perCustomerSummary: Record<string, { rows: number; spiff: number; unmatched: number; error?: string }> = {};
  const errors: Record<string, string> = {};

  // Sequential — 15 bridge jobs back-to-back is fine and easier to debug.
  for (const program of progs) {
    try {
      const rawLines = await fetchProgramLines(program, opts.dateFrom, opts.dateTo);
      const toInsert: any[] = [];
      let unmatched = 0;
      let spiffSum = 0;

      for (const r of rawLines) {
        const inScope = isInScope(r.product_group_id, program.product_scope);
        const vs = String(r.validation_status ?? "").trim();
        const vsUpper = vs.toUpperCase();
        const isSpecial = vsUpper.includes("SPECIAL");
        const excludedSpecial = program.exclude_special_orders && isSpecial;
        const included = inScope && !excludedSpecial;
        const exclusion_reason = !inScope
          ? "out_of_scope"
          : excludedSpecial
            ? "special_order"
            : null;

        // Flag (don't exclude) when validation_status is suspicious.
        const flags: Record<string, any> = {};
        if (vs && (vsUpper.includes("CANCEL") || vsUpper.includes("UNAPPROV") || vsUpper.includes("HOLD") || vsUpper.includes("REJECT"))) {
          flags.validation_warning = vs;
        }

        const ext = num(r.extended_price);
        const spiff = included ? +(ext * Number(program.rate)).toFixed(6) : 0;
        const parsed = parseWritingRep(r.po_no);
        if (parsed.confidence === "unmatched" && included) unmatched++;
        if (included) spiffSum += spiff;

        toInsert.push({
          run_id: runId,
          program_id: program.id,
          customer_id: program.customer_id,
          order_date: r.order_date,
          order_no: r.order_no != null ? String(r.order_no) : null,
          po_no: r.po_no,
          item_id: r.item_id,
          item_desc: r.item_desc,
          qty_ordered: num(r.qty_ordered),
          unit_price: num(r.unit_price),
          extended_price: ext,
          product_group_id: r.product_group_id != null ? String(r.product_group_id) : null,
          spiff_amount: spiff,
          writing_rep: parsed.rep,
          rep_parse_confidence: parsed.confidence,
          included,
          exclusion_reason,
          flags,
        });
      }

      // Batched insert
      for (let i = 0; i < toInsert.length; i += 500) {
        const slice = toInsert.slice(i, i + 500);
        const { error } = await supabaseAdmin.from("spiff_run_lines").insert(slice);
        if (error) throw new Error(error.message);
      }

      // Build checks from the just-inserted lines (use the in-memory shape).
      const checkInputs = toInsert.map((l) => ({
        spiff_amount: Number(l.spiff_amount) || 0,
        writing_rep: l.writing_rep,
        included: l.included,
        rep_parse_confidence: l.rep_parse_confidence,
      }));
      const checks = buildChecksForProgram(program, checkInputs);
      if (checks.length) {
        const { error } = await supabaseAdmin
          .from("spiff_checks")
          .insert(checks.map((c) => ({ ...c, run_id: runId, status: "pending" })));
        if (error) throw new Error(error.message);
      }

      perCustomerSummary[program.customer_id] = {
        rows: toInsert.length,
        spiff: spiffSum,
        unmatched,
      };
    } catch (e: any) {
      const msg = e?.message ?? "unknown error";
      errors[program.customer_id] = msg;
      perCustomerSummary[program.customer_id] = {
        rows: 0,
        spiff: 0,
        unmatched: 0,
        error: msg,
      };
    }
  }

  // AR aging gate — single SQL.
  const customerIds = progs.map((p) => p.customer_id);
  const aging = await fetchAging(customerIds);

  await supabaseAdmin
    .from("spiff_runs")
    .update({
      totals: {
        per_customer: perCustomerSummary,
        aging: aging.error ? { error: aging.error } : aging.byCustomer,
        errors,
        generated_at: new Date().toISOString(),
      },
    })
    .eq("id", runId);

  await supabaseAdmin.from("activity_events").insert({
    event_type: "spiff.generated",
    entity_type: "spiff_run",
    entity_id: runId,
    actor_id: opts.userId,
    message: `SPIFF run generated for ${opts.quarterLabel}`,
    metadata: { programs: progs.length, errors: Object.keys(errors).length },
  });

  return { runId, programsProcessed: progs.length, errors };
}
