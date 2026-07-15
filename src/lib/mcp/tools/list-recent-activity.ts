import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAsUser, unauthenticated, errorResult } from "../supabase";

export default defineTool({
  name: "list_recent_activity",
  title: "List recent activity",
  description:
    "List recent Nelson AI activity events (orders, imports, jobs, background events). Read-only. Results are filtered by row-level security to what the caller can see in the web app.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Max number of events to return (1-100)."),
    event_type: z
      .string()
      .optional()
      .describe("Optional exact match on event_type (e.g. 'order.created')."),
    entity_type: z
      .string()
      .optional()
      .describe("Optional exact match on entity_type (e.g. 'order', 'spiff_run')."),
    since_hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional()
      .describe("Only include events created within the last N hours."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const sb = supabaseAsUser(ctx);
    let q = sb
      .from("activity_events")
      .select("id, created_at, event_type, entity_type, entity_id, actor_name, message, metadata")
      .order("created_at", { ascending: false })
      .limit(input.limit);
    if (input.event_type) q = q.eq("event_type", input.event_type);
    if (input.entity_type) q = q.eq("entity_type", input.entity_type);
    if (input.since_hours) {
      const cutoff = new Date(Date.now() - input.since_hours * 3600_000).toISOString();
      q = q.gte("created_at", cutoff);
    }
    const { data, error } = await q;
    if (error) return errorResult(error.message);
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { events: data ?? [] },
    };
  },
});
