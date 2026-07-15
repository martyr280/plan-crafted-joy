import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseAsUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Return the currently authenticated Nelson AI user (id, email, display name, roles). Use to verify the MCP session is connected as the expected user before calling other tools.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const sb = supabaseAsUser(ctx);
    const userId = ctx.getUserId();

    const [profileRes, rolesRes] = await Promise.all([
      sb.from("profiles").select("id, email, display_name").eq("id", userId).maybeSingle(),
      sb.from("user_roles").select("role").eq("user_id", userId),
    ]);

    const profile = profileRes.data ?? { id: userId, email: ctx.getUserEmail(), display_name: null };
    const roles = (rolesRes.data ?? []).map((r: { role: string }) => r.role);

    const summary = {
      id: profile.id,
      email: profile.email,
      display_name: profile.display_name,
      roles,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
});

// Silence unused import warning under strict TS
void z;
