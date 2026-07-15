import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAsUser, unauthenticated, errorResult } from "../supabase";

export default defineTool({
  name: "list_ar_aging",
  title: "List AR aging",
  description:
    "List NDI accounts-receivable aging rows for the signed-in user's tenant scope. Read-only. Supports filtering by aging bucket, minimum amount past due, and customer name substring. Results respect row-level security.",
  inputSchema: {
    limit: z.number().int().min(1).max(200).default(50).describe("Max rows (1-200)."),
    bucket: z
      .string()
      .optional()
      .describe("Optional aging bucket (e.g. '0-30', '31-60', '61-90', '90+')."),
    min_amount_due: z
      .number()
      .optional()
      .describe("Only include invoices with amount_due >= this value."),
    customer_contains: z
      .string()
      .optional()
      .describe("Case-insensitive substring match on customer_name."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const sb = supabaseAsUser(ctx);
    let q = sb
      .from("ar_aging")
      .select(
        "id, invoice_number, customer_id, customer_name, customer_email, amount_due, bucket, days_past_due, due_date, collection_status, last_contacted_at, synced_at",
      )
      .order("days_past_due", { ascending: false })
      .limit(input.limit);
    if (input.bucket) q = q.eq("bucket", input.bucket);
    if (typeof input.min_amount_due === "number") q = q.gte("amount_due", input.min_amount_due);
    if (input.customer_contains) q = q.ilike("customer_name", `%${input.customer_contains}%`);
    const { data, error } = await q;
    if (error) return errorResult(error.message);
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { rows: data ?? [] },
    };
  },
});
