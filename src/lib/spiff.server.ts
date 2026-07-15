// Server-only SPIFF generation logic. Pulls real P21 lines via the existing
// agent bridge (`sql.select`), parses writing reps, applies product-scope
// filters, computes per-line spiff, builds payee checks, and persists
// everything under a spiff_runs row.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runJob } from "./p21.server";
import {
  buildSpiffLinesSql,
  buildSpiffLinesAllSql,
  SPIFF_AGING_SQL,
  EXCLUSION_RULES,
  INVOICE_LINE_LINKAGE_CANDIDATES,
  OE_LINE_LINKAGE_CANDIDATES,
  INVOICED_QTY_CANDIDATES,
  EXTENDED_PRICE_CANDIDATES,
  classifySampleCatalog,
  isInScope,
  type ProductScope,
  type SchemaMapping,
} from "./spiff/constants";
import { parseWritingRep } from "./spiff/parser";

const SCHEMA_TIMEOUT_MS = 30_000;

// Runtime schema discovery. One extra bridge call per run — cheap relative
// to the lines query — that reads INFORMATION_SCHEMA.COLUMNS for the two
// tables we care about, resolves each moving column by candidate priority,
// and returns a SchemaMapping we substitute into the lines-SQL template.
// If no linkage candidate exists on invoice_line, we fall back to
// order-level aggregation and mark linkage_mode='order_level'.
export async function discoverSpiffSchema(): Promise<SchemaMapping> {
  const sql = `
    SELECT LOWER(TABLE_NAME) AS table_name, LOWER(COLUMN_NAME) AS column_name
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME IN ('invoice_line', 'oe_line')
  `.trim();
  const { result } = await runJob("sql.select", { sql, slug: "spiff-schema" }, SCHEMA_TIMEOUT_MS);
  const rows = (((result as any)?.rows ?? []) as Array<{ table_name: string; column_name: string }>);
  const invCols = new Set<string>();
  const oeCols = new Set<string>();
  for (const r of rows) {
    const t = String(r.table_name ?? "").toLowerCase();
    const c = String(r.column_name ?? "").toLowerCase();
    if (t === "invoice_line") invCols.add(c);
    else if (t === "oe_line") oeCols.add(c);
  }

  if (invCols.size === 0) {
    throw new Error("Schema discovery returned no columns for dbo.invoice_line");
  }
  if (oeCols.size === 0) {
    throw new Error("Schema discovery returned no columns for dbo.oe_line");
  }
  if (!invCols.has("order_no")) {
    throw new Error(
      `dbo.invoice_line has no 'order_no' column — cannot join to oe_line. Columns found: [${Array.from(invCols).sort().join(", ")}]`,
    );
  }

  const extPrice = EXTENDED_PRICE_CANDIDATES.find((c) => invCols.has(c));
  if (!extPrice) {
    throw new Error(
      `dbo.invoice_line has no extended-price column. Tried: [${EXTENDED_PRICE_CANDIDATES.join(", ")}]. Columns found: [${Array.from(invCols).sort().join(", ")}]`,
    );
  }
  const invoicedQty = INVOICED_QTY_CANDIDATES.find((c) => invCols.has(c));
  if (!invoicedQty) {
    throw new Error(
      `dbo.invoice_line has no invoiced-quantity column. Tried: [${INVOICED_QTY_CANDIDATES.join(", ")}]. Columns found: [${Array.from(invCols).sort().join(", ")}]`,
    );
  }
  const oeLinkage = OE_LINE_LINKAGE_CANDIDATES.find((c) => oeCols.has(c));
  if (!oeLinkage) {
    throw new Error(
      `dbo.oe_line has no line-number column. Tried: [${OE_LINE_LINKAGE_CANDIDATES.join(", ")}]. Columns found: [${Array.from(oeCols).sort().join(", ")}]`,
    );
  }

  const invLinkage = INVOICE_LINE_LINKAGE_CANDIDATES.find((c) => invCols.has(c)) ?? null;
  const linkage_mode: SchemaMapping["linkage_mode"] = invLinkage ? "line_level" : "order_level";

  return {
    invoice_line_columns: Array.from(invCols).sort(),
    oe_line_columns: Array.from(oeCols).sort(),
    invoice_line_linkage: invLinkage,
    oe_line_linkage: oeLinkage,
    invoiced_qty: invoicedQty,
    extended_price: extPrice,
    linkage_mode,
  };
}

const LINES_TIMEOUT_MS = 180_000;
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
  line_no: number | string | null;
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
  cancel_flag: string | null;
  projected_order: string | null;
  kit: number | null;
  invoiced_qty: number | string | null;
  invoiced_amount: number | string | null;
  first_invoice_date: string | null;
  last_invoice_date: string | null;
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
  dateTo: string,
  mapping: SchemaMapping,
): Promise<RawLine[]> {
  const { result } = await runJob(
    "sql.select",
    {
      sql: buildSpiffLinesSql(mapping),
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

// Pulls every program's lines in ONE bridge job to stay within the edge
// request budget. Returns a map keyed by customer_id.
async function fetchAllProgramLines(
  customerIds: string[],
  dateFrom: string,
  dateTo: string,
  mapping: SchemaMapping,
): Promise<Map<string, RawLine[]>> {
  const out = new Map<string, RawLine[]>();
  if (customerIds.length === 0) return out;
  // Whitelist customer ids — they come from spiff_programs (admin seed) but
  // are interpolated into SQL, so defensively constrain the alphabet.
  const safe = customerIds.filter((c) => /^[A-Za-z0-9_-]+$/.test(c));
  for (const c of safe) out.set(c, []);
  if (safe.length === 0) return out;
  const inList = safe.map((c) => `'${c}'`).join(",");
  const sql = buildSpiffLinesAllSql(mapping).replace("{customer_ids}", inList);
  const { result } = await runJob(
    "sql.select",
    { sql, params: { dateFrom, dateTo }, slug: "spiff-all" },
    LINES_TIMEOUT_MS
  );
  const rows = ((result as any)?.rows ?? []) as RawLine[];
  for (const r of rows) {
    const key = String(r.customer_id);
    const arr = out.get(key) ?? [];
    arr.push(r);
    out.set(key, arr);
  }
  return out;
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

  const perCustomerSummary: Record<string, { rows: number; spiff: number; unmatched: number; missing_product_group?: number; error?: string }> = {};
  const errors: Record<string, string> = {};

  // ONE bridge call pulls every program's lines. Previously we polled the
  // agent once per program, which routinely exceeded the edge request budget
  // and surfaced to the user as "Failed to fetch".
  const linesByCustomer = await fetchAllProgramLines(
    progs.map((p) => p.customer_id),
    opts.dateFrom,
    opts.dateTo
  );

  // Per-reason exclusion counters across the whole run.
  const exclusionCounts: Record<string, number> = {
    not_invoiced: 0,
    cancelled: 0,
    sample: 0,
    catalog: 0,
    out_of_scope: 0,
    missing_product_group: 0,
    special_order: 0,
  };

  for (const program of progs) {
    try {
      const rawLines = linesByCustomer.get(program.customer_id) ?? [];
      const toInsert: any[] = [];
      let unmatched = 0;
      let spiffSum = 0;
      let missingProductGroup = 0;
      const perProgramExcl: Record<string, number> = {};

      const scoped =
        program.product_scope === "pl_ryker_jax" ||
        program.product_scope === "pl_ryker_jax_no_seating";

      for (const r of rawLines) {
        const pg = r.product_group_id != null ? String(r.product_group_id).trim() : "";
        const missingPg = scoped && pg === "";
        const inScope = missingPg ? false : isInScope(r.product_group_id, program.product_scope);
        const vs = String(r.validation_status ?? "").trim();
        const vsUpper = vs.toUpperCase();
        const isSpecial = vsUpper.includes("SPECIAL");
        const excludedSpecial = program.exclude_special_orders && isSpecial;

        // Invoiced-only (Kim rule #1). Base spiff on invoiced_amount.
        const invoicedQty = num(r.invoiced_qty);
        const invoicedAmt = num(r.invoiced_amount);
        const notInvoiced = invoicedQty <= 0 && invoicedAmt <= 0;

        // Cancelled (Kim rule #3) — header cancel flag OR validation_status CANCEL.
        const cancelFlag = String(r.cancel_flag ?? "").trim().toUpperCase();
        const isCancelled = cancelFlag === "Y" || vsUpper.includes("CANCEL");

        // Samples / Catalogs (Kim rules #4, #5).
        const scReason = classifySampleCatalog({
          itemId: r.item_id,
          itemDesc: r.item_desc,
          productGroupId: r.product_group_id,
        });

        // Priority: cancelled > not_invoiced > sample > catalog > scope > special.
        let exclusion_reason: string | null = null;
        if (isCancelled) exclusion_reason = "cancelled";
        else if (notInvoiced) exclusion_reason = "not_invoiced";
        else if (scReason === "sample") exclusion_reason = "sample";
        else if (scReason === "catalog") exclusion_reason = "catalog";
        else if (missingPg) exclusion_reason = "missing_product_group";
        else if (!inScope) exclusion_reason = "out_of_scope";
        else if (excludedSpecial) exclusion_reason = "special_order";

        const included = exclusion_reason === null;

        const flags: Record<string, any> = {};
        if (vs && (vsUpper.includes("UNAPPROV") || vsUpper.includes("HOLD") || vsUpper.includes("REJECT"))) {
          flags.validation_warning = vs;
        }
        if (isCancelled && vs) flags.validation_warning = vs || "CANCELLED";
        if (missingPg) {
          flags.missing_product_group = true;
          missingProductGroup++;
        }
        if (notInvoiced) flags.not_invoiced = true;

        if (exclusion_reason) {
          perProgramExcl[exclusion_reason] = (perProgramExcl[exclusion_reason] ?? 0) + 1;
          exclusionCounts[exclusion_reason] = (exclusionCounts[exclusion_reason] ?? 0) + 1;
        }

        // Use INVOICED qty/amount as the basis of record (Kim rule #1). Falls
        // back to ordered values only when nothing was invoiced so the row is
        // still auditable in the UI even though included=false.
        const qtyForRow = notInvoiced ? num(r.qty_ordered) : invoicedQty;
        const extForRow = notInvoiced ? num(r.extended_price) : invoicedAmt;
        const spiff = included ? +(extForRow * Number(program.rate)).toFixed(6) : 0;
        const parsed = parseWritingRep(r.po_no);
        if (parsed.confidence === "unmatched" && included) unmatched++;
        if (included) spiffSum += spiff;

        toInsert.push({
          run_id: runId,
          program_id: program.id,
          customer_id: program.customer_id,
          order_date: r.order_date,
          first_invoice_date: r.first_invoice_date,
          last_invoice_date: r.last_invoice_date,
          invoice_date: r.last_invoice_date, // convenience mirror
          order_no: r.order_no != null ? String(r.order_no) : null,
          po_no: r.po_no,
          item_id: r.item_id,
          item_desc: r.item_desc,
          qty_ordered: qtyForRow,
          unit_price: num(r.unit_price),
          extended_price: extForRow,
          product_group_id: r.product_group_id != null ? String(r.product_group_id) : null,
          spiff_amount: spiff,
          writing_rep: parsed.rep,
          rep_parse_confidence: parsed.confidence,
          included,
          exclusion_reason,
          flags,
        });
      }

      for (let i = 0; i < toInsert.length; i += 500) {
        const slice = toInsert.slice(i, i + 500);
        const { error } = await supabaseAdmin.from("spiff_run_lines").insert(slice);
        if (error) throw new Error(error.message);
      }

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
        missing_product_group: missingProductGroup,
        excluded: perProgramExcl,
      } as any;
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

  const customerIds = progs.map((p) => p.customer_id);
  const aging = await fetchAging(customerIds);

  await supabaseAdmin
    .from("spiff_runs")
    .update({
      totals: {
        per_customer: perCustomerSummary,
        aging: aging.error ? { error: aging.error } : aging.byCustomer,
        errors,
        exclusion_counts: exclusionCounts,
        exclusion_rules: EXCLUSION_RULES,
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
    metadata: { programs: progs.length, errors: Object.keys(errors).length, exclusions: exclusionCounts },
  });

  return { runId, programsProcessed: progs.length, errors };
}


// =====================================================================
// Email distribution
// =====================================================================

async function sendResendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  filename: string;
  content: Buffer;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = process.env.NELSON_FROM_EMAIL || "Nelson AI <noreply@nelsonbot.ai>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      attachments: [{ filename: opts.filename, content: opts.content.toString("base64") }],
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend send failed [${r.status}]: ${body.slice(0, 300)}`);
  }
  return r.json();
}

function appUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.PUBLIC_APP_URL ||
    "https://nelsonbot.ai"
  ).replace(/\/$/, "");
}

function money(n: number): string {
  return Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export async function sendForApprovalCore(opts: {
  runId: string;
  userId: string;
}): Promise<{
  sent: Array<{ rep_org: string; emails: string[]; customers: string[] }>;
  skipped: Array<{ rep_org: string; reason: string }>;
}> {
  const { buildSpiffWorkbook } = await import("./spiff/workbook.server");

  const { data: run } = await supabaseAdmin
    .from("spiff_runs")
    .select("*")
    .eq("id", opts.runId)
    .single();
  if (!run) throw new Error("Run not found");

  const { data: checks } = await supabaseAdmin
    .from("spiff_checks")
    .select("payee, customer_id")
    .eq("run_id", opts.runId);
  if ((checks ?? []).some((c) => c.payee === "(Unassigned)")) {
    throw new Error("Resolve all (Unassigned) payees before sending for approval.");
  }

  const { data: programs } = await supabaseAdmin.from("spiff_programs").select("*").eq("active", true);
  const { data: contacts } = await supabaseAdmin
    .from("spiff_contacts")
    .select("*")
    .eq("kind", "salesrep_approver")
    .eq("active", true);

  // Group programs by rep_org
  const byOrg = new Map<string, any[]>();
  for (const p of programs ?? []) {
    const arr = byOrg.get(p.rep_org) ?? [];
    arr.push(p);
    byOrg.set(p.rep_org, arr);
  }

  const sent: Array<{ rep_org: string; emails: string[]; customers: string[] }> = [];
  const skipped: Array<{ rep_org: string; reason: string }> = [];

  for (const [rep_org, progs] of byOrg) {
    const emails = (contacts ?? [])
      .filter((c) => c.label.trim().toLowerCase() === rep_org.trim().toLowerCase())
      .map((c) => c.email);
    if (emails.length === 0) {
      skipped.push({ rep_org, reason: "no contact configured" });
      continue;
    }
    const customerIds = progs.map((p) => p.customer_id);

    // Per-customer totals (included only)
    const { data: lines } = await supabaseAdmin
      .from("spiff_run_lines")
      .select("customer_id, spiff_amount, included")
      .eq("run_id", opts.runId)
      .in("customer_id", customerIds)
      .limit(50000);
    const totals = new Map<string, number>();
    for (const l of lines ?? []) {
      if (!l.included) continue;
      totals.set(l.customer_id, (totals.get(l.customer_id) ?? 0) + Number(l.spiff_amount || 0));
    }

    const wb = await buildSpiffWorkbook(opts.runId, { customerIds });
    const safeOrg = rep_org.replace(/[^A-Za-z0-9._-]+/g, "_");
    const filename = `SPIFF-${run.quarter_label}-${safeOrg}.xlsx`;

    const rows = progs
      .map((p) => {
        const t = totals.get(p.customer_id) ?? 0;
        return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${p.customer_name}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;font-family:monospace">${money(t)}</td></tr>`;
      })
      .join("");

    const html = `
      <p>Hi,</p>
      <p>The <b>${run.quarter_label}</b> SPIFF run is ready for your review. Your customers and totals are listed below; the attached workbook has the line-level detail and payee breakdown.</p>
      <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        <thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:2px solid #333">Customer</th><th style="text-align:right;padding:4px 8px;border-bottom:2px solid #333">SPIFF</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p>Please review and reply to approve, or open <a href="${appUrl()}/spiff">${appUrl()}/spiff</a> for the live view.</p>
      <p style="color:#777;font-size:12px">— Nelson AI · SPIFF</p>
    `;

    await sendResendEmail({
      to: emails,
      subject: `SPIFF ${run.quarter_label} — please review and approve`,
      html,
      filename,
      content: wb.buffer,
    });
    sent.push({ rep_org, emails, customers: progs.map((p) => p.customer_name) });
  }

  await supabaseAdmin.from("spiff_runs").update({ status: "in_review" }).eq("id", opts.runId);
  await supabaseAdmin.from("activity_events").insert({
    event_type: "spiff.sent_for_approval",
    entity_type: "spiff_run",
    entity_id: opts.runId,
    actor_id: opts.userId,
    message: `SPIFF ${run.quarter_label} sent for approval (${sent.length} rep orgs, ${skipped.length} skipped)`,
    metadata: { sent, skipped },
  });

  return { sent, skipped };
}

export async function sendToApCore(opts: {
  runId: string;
  userId: string;
}): Promise<{ to: string[]; payeeCount: number }> {
  const { buildSpiffWorkbook } = await import("./spiff/workbook.server");

  const { data: run } = await supabaseAdmin
    .from("spiff_runs")
    .select("*")
    .eq("id", opts.runId)
    .single();
  if (!run) throw new Error("Run not found");
  if (run.status !== "approved") {
    throw new Error("Run must be approved before sending to AP.");
  }

  const { data: contacts } = await supabaseAdmin
    .from("spiff_contacts")
    .select("email")
    .eq("kind", "ap")
    .eq("active", true);
  const to = (contacts ?? []).map((c) => c.email);
  if (to.length === 0) throw new Error("No active AP contacts configured.");

  const { data: programs } = await supabaseAdmin.from("spiff_programs").select("*");
  const progById = new Map((programs ?? []).map((p) => [p.id, p as any]));

  const { data: checks } = await supabaseAdmin
    .from("spiff_checks")
    .select("*")
    .eq("run_id", opts.runId)
    .order("customer_id");

  // Group by customer for HTML payee table
  const byCust = new Map<string, any[]>();
  for (const c of checks ?? []) {
    const arr = byCust.get(c.customer_id) ?? [];
    arr.push(c);
    byCust.set(c.customer_id, arr);
  }

  let html = `<p>The <b>${run.quarter_label}</b> SPIFF run is approved. Below are the payees and amounts to cut checks for; the workbook is attached for line-level detail.</p>`;
  for (const [custId, list] of byCust) {
    const p = list[0] ? progById.get(list[0].program_id) : null;
    const name = p?.customer_name ?? custId;
    html += `<h3 style="margin:18px 0 4px;font-family:sans-serif">${name} <span style="color:#888;font-weight:normal">(${custId})</span></h3>`;
    html += `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;margin-bottom:8px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:2px solid #333">Payee</th><th style="text-align:right;padding:4px 8px;border-bottom:2px solid #333">Amount</th><th style="padding:4px 8px;border-bottom:2px solid #333">Note</th></tr></thead><tbody>`;
    for (const c of list) {
      const note = c.below_minimum ? "no check — under minimum" : "";
      const greyed = c.below_minimum
        ? "color:#888;font-style:italic"
        : "";
      html += `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;${greyed}">${c.payee}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;${greyed}">${money(Number(c.amount))}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;color:#a36c00">${note}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `<p style="color:#777;font-size:12px">— Nelson AI · SPIFF</p>`;

  const wb = await buildSpiffWorkbook(opts.runId);
  await sendResendEmail({
    to,
    subject: `SPIFF ${run.quarter_label} — checks for payment`,
    html,
    filename: wb.filename,
    content: wb.buffer,
  });

  await supabaseAdmin.from("spiff_runs").update({ status: "sent_to_ap" }).eq("id", opts.runId);
  await supabaseAdmin
    .from("spiff_checks")
    .update({ status: "sent" })
    .eq("run_id", opts.runId)
    .eq("status", "approved");
  await supabaseAdmin.from("activity_events").insert({
    event_type: "spiff.sent_to_ap",
    entity_type: "spiff_run",
    entity_id: opts.runId,
    actor_id: opts.userId,
    message: `SPIFF ${run.quarter_label} sent to AP (${to.length} recipients)`,
    metadata: { to, payees: (checks ?? []).length },
  });

  return { to, payeeCount: (checks ?? []).length };
}

// =====================================================================
// Quarterly automation hook (called from /api/public/run-sql-schedules)
// =====================================================================

function quarterLabelForDate(d: Date): { quarter: string; from: string; toExclusive: string } {
  // Returns the JUST-ENDED quarter relative to d (i.e. the one we should generate now).
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1..12
  // Determine which quarter we are currently IN, then walk back one.
  let qIn: number;
  if (m <= 3) qIn = 1;
  else if (m <= 6) qIn = 2;
  else if (m <= 9) qIn = 3;
  else qIn = 4;
  let pQ = qIn - 1;
  let pY = y;
  if (pQ === 0) {
    pQ = 4;
    pY = y - 1;
  }
  const startMonth = (pQ - 1) * 3 + 1; // 1,4,7,10
  const endMonthExclusive = startMonth + 3; // 4,7,10,13
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${pY}-${pad(startMonth)}-01`;
  const toExclusive =
    endMonthExclusive === 13
      ? `${pY + 1}-01-01`
      : `${pY}-${pad(endMonthExclusive)}-01`;
  return { quarter: `Q${pQ}-${pY}`, from, toExclusive };
}

export async function runSpiffAutomationTick(now: Date = new Date()): Promise<{
  ran: boolean;
  reason?: string;
  runId?: string;
  quarter?: string;
}> {
  const { data: cfg } = await supabaseAdmin
    .from("spiff_automation")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (!cfg || !cfg.enabled) return { ran: false, reason: "disabled" };

  // Compute "now" in the configured timezone, day/hour.
  const tz = cfg.timezone || "America/Chicago";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? "0");
  const day = get("day");
  const hour = get("hour");
  if (day !== Number(cfg.day_of_month)) return { ran: false, reason: "wrong day" };
  if (hour < Number(cfg.send_hour)) return { ran: false, reason: "too early" };

  const { quarter, from, toExclusive } = quarterLabelForDate(now);
  if (cfg.last_auto_quarter === quarter) return { ran: false, reason: "already ran for this quarter" };

  try {
    const { runId } = await generateSpiffRunCore({
      quarterLabel: quarter,
      dateFrom: from,
      dateTo: toExclusive,
      userId: "00000000-0000-0000-0000-000000000000",
    });

    let approvalsResult: any = null;
    if (cfg.send_approvals) {
      try {
        approvalsResult = await sendForApprovalCore({
          runId,
          userId: "00000000-0000-0000-0000-000000000000",
        });
      } catch (e: any) {
        approvalsResult = { error: e?.message ?? String(e) };
      }
    }

    await supabaseAdmin
      .from("spiff_automation")
      .update({
        last_auto_quarter: quarter,
        last_auto_run_at: new Date().toISOString(),
        last_auto_status: "success",
        last_auto_error: approvalsResult?.error ?? null,
      })
      .eq("id", cfg.id);

    await supabaseAdmin.from("activity_events").insert({
      event_type: "spiff.auto_generated",
      entity_type: "spiff_run",
      entity_id: runId,
      message: `Auto-generated SPIFF run for ${quarter}${cfg.send_approvals ? " and sent approvals" : ""}`,
      metadata: { quarter, approvalsResult },
    });
    return { ran: true, runId, quarter };
  } catch (e: any) {
    await supabaseAdmin
      .from("spiff_automation")
      .update({
        last_auto_run_at: new Date().toISOString(),
        last_auto_status: "error",
        last_auto_error: e?.message ?? String(e),
      })
      .eq("id", cfg.id);
    return { ran: false, reason: e?.message ?? String(e) };
  }
}

