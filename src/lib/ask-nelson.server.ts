// Server-only helpers for Ask Nelson chat.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Whitelist of tables the model may query, with the columns it may see.
// Sensitive columns (emails, raw payloads) are intentionally trimmed.
export const TABLE_WHITELIST: Record<string, string[]> = {
  orders: ["id", "p21_order_id", "customer_id", "customer_name", "po_number", "source", "status", "line_items", "ai_confidence", "ai_flags", "reviewed_at", "p21_submitted_at", "created_at", "updated_at"],
  inbound_emails: ["id", "message_id", "from_addr", "from_name", "to_addr", "subject", "status", "classification", "confidence", "ai_summary", "ai_flags", "created_record_type", "created_record_id", "received_at", "processed_at"],
  price_list: ["id", "item", "item_short", "description", "mfg", "category", "cat_number", "list_price", "dealer_cost", "price_l1", "price_l2", "price_l3", "price_l4", "price_l5", "price_showroom", "er_cost", "weight", "effective_date", "updated_at"],
  inventory_snapshots: ["id", "item_id", "item_desc", "birm_qty", "dallas_qty", "ocala_qty", "total_qty", "e2g_price", "weight", "snapshot_date", "next_due_in"],
  e2g_inventory_snapshot: ["id", "item_id", "item_desc", "birm", "dallas", "ocala", "total", "e2g_price", "weight", "next_due_date", "next_due_in_display", "synced_at"],
  ar_aging: ["id", "customer_id", "customer_name", "invoice_number", "amount_due", "due_date", "days_past_due", "bucket", "collection_status", "last_contacted_at", "synced_at"],
  collection_emails: ["id", "ar_aging_id", "status", "automated", "sent_at"],
  damage_reports: ["id", "order_id", "p21_order_id", "samsara_document_id", "stage", "damage_type", "severity", "driver_name", "dealer_id", "installer_id", "route_code", "status", "resolution", "created_at"],
  fleet_loads: ["id", "route_code", "driver_name", "truck_id", "departure_date", "status", "total_weight", "total_cubic_ft", "capacity_pct", "created_at"],
  fleet_routes: ["id", "hub", "group_label", "route_code", "destination_city", "delivery_day", "driver_name", "schedule_notes", "updated_at"],
  design_quotes: ["id", "quote_name", "sif_date", "source_file", "line_count", "room_count", "total_list", "total_sell", "created_at"],
  design_quote_lines: ["id", "quote_id", "line_no", "room", "part_number", "description", "quantity", "list_price"],
  spiff_calculations: ["id", "quarter", "customer_id", "customer_name", "sales_rep", "gross_sales", "spiff_amount", "status", "approved_at", "created_at"],
  spiff_rules: ["id", "customer_id", "customer_name", "sku_filter", "rate_type", "rate_value", "sales_rep_split", "active", "notes", "created_at"],
  catalogs: ["id", "name", "kind", "published_date", "pages", "sku_count", "parse_status", "parsed_at", "size_bytes", "created_at"],
  catalog_items: ["id", "catalog_id", "sku", "description", "mfg", "list_price", "page"],
  website_items: ["id", "sku", "family", "brand", "category", "name", "description", "in_stock", "stock_text", "detail_url", "crawled_at"],
  website_crawls: ["id", "status", "pages_crawled", "skus_found", "notes", "started_at", "completed_at"],
  sku_crossref: ["id", "competitor_sku", "ndi_sku", "confidence", "source", "created_at"],
  pricer_publications: ["id", "name", "orientation", "portrait_level", "row_count", "status", "generated_at"],
  activity_events: ["id", "event_type", "entity_type", "entity_id", "actor_name", "message", "metadata", "created_at"],
  app_settings: ["key", "value", "updated_at"],
  sales_cache: ["id", "rep_code", "period", "date_from", "date_to", "cached_at"],
  report_runs: ["id", "schedule_id", "status", "recipients_count", "notes", "started_at", "completed_at"],
  report_schedules: ["id", "name", "type", "template", "schedule_cron", "date_range", "format", "active", "last_status", "last_run_at"],
  p21_bridge_jobs: ["id", "kind", "status", "agent_id", "error", "created_at", "claimed_at", "completed_at"],
  p21_bridge_agents: ["id", "name", "version", "ip", "last_seen_at", "created_at"],
};

export function getSchemaDigest(): string {
  return Object.entries(TABLE_WHITELIST)
    .map(([t, cols]) => `${t}(${cols.join(", ")})`)
    .join("\n");
}

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "is" | "in";
interface Filter { column: string; op: FilterOp; value: unknown }

export async function queryTable(input: {
  table: string;
  select?: string[];
  filters?: Filter[];
  order?: { column: string; ascending?: boolean };
  limit?: number;
}) {
  const cols = TABLE_WHITELIST[input.table];
  if (!cols) throw new Error(`Table "${input.table}" is not accessible.`);
  const selectCols = input.select && input.select.length
    ? input.select.filter((c) => cols.includes(c))
    : cols;
  if (!selectCols.length) throw new Error(`No selectable columns for ${input.table}.`);

  let q = supabaseAdmin.from(input.table as never).select(selectCols.join(","));
  for (const f of input.filters ?? []) {
    if (!cols.includes(f.column)) throw new Error(`Unknown column "${f.column}" on ${input.table}.`);
    // @ts-expect-error dynamic op
    q = q[f.op](f.column, f.value);
  }
  if (input.order && cols.includes(input.order.column)) {
    q = q.order(input.order.column, { ascending: input.order.ascending ?? true });
  }
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  q = q.limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { rows: data ?? [], rowCount: (data ?? []).length, limit };
}

export async function countTable(input: { table: string; filters?: Filter[] }) {
  const cols = TABLE_WHITELIST[input.table];
  if (!cols) throw new Error(`Table "${input.table}" is not accessible.`);
  let q = supabaseAdmin.from(input.table as never).select("*", { count: "exact", head: true });
  for (const f of input.filters ?? []) {
    if (!cols.includes(f.column)) throw new Error(`Unknown column "${f.column}" on ${input.table}.`);
    // @ts-expect-error dynamic op
    q = q[f.op](f.column, f.value);
  }
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return { count: count ?? 0 };
}

// ---- Lovable AI Gateway helpers ----
const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface ChatMsg { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: any; tool_call_id?: string; name?: string }

export async function callGateway(opts: {
  model: string;
  messages: ChatMsg[];
  tools?: any[];
  tool_choice?: any;
  reasoning?: { effort: "minimal" | "low" | "medium" | "high" | "xhigh" };
}) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools,
      tool_choice: opts.tool_choice,
      reasoning: opts.reasoning,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 429) throw new Error("Rate limit hit, please try again shortly.");
    if (res.status === 402) throw new Error("AI credits exhausted. Top up in Workspace → Usage.");
    throw new Error(`AI gateway error ${res.status}: ${t}`);
  }
  return res.json();
}

export const ASK_NELSON_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_tables",
      description: "Return the catalog of database tables and columns Nelson is allowed to read. Call this first if you are unsure what data exists.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "query_table",
      description: "Read rows from a whitelisted table. Always prefer narrow filters and small limits. Returns at most 200 rows.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string" },
          select: { type: "array", items: { type: "string" } },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"] },
                value: {},
              },
              required: ["column", "op", "value"],
              additionalProperties: false,
            },
          },
          order: {
            type: "object",
            properties: { column: { type: "string" }, ascending: { type: "boolean" } },
            required: ["column"],
            additionalProperties: false,
          },
          limit: { type: "number" },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_table",
      description: "Return the number of rows in a table matching the given filters. Cheap; use to check existence.",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string" },
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"] },
                value: {},
              },
              required: ["column", "op", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["table"],
        additionalProperties: false,
      },
    },
  },
];

export async function runTool(name: string, args: any) {
  if (name === "list_tables") {
    return Object.fromEntries(Object.entries(TABLE_WHITELIST).map(([t, cols]) => [t, cols]));
  }
  if (name === "query_table") return await queryTable(args);
  if (name === "count_table") return await countTable(args);
  throw new Error(`Unknown tool: ${name}`);
}
