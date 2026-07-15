import { auth, defineMcp } from "@lovable.dev/mcp-js";
import whoami from "./tools/whoami";
import listRecentActivity from "./tools/list-recent-activity";
import listArAging from "./tools/list-ar-aging";

// The OAuth issuer must be the direct Supabase host, not the .lovable.cloud
// proxy that SUPABASE_URL points at in published builds. Vite inlines
// VITE_SUPABASE_PROJECT_ID at build time; the fallback keeps the issuer
// well-formed during the manifest-extract eval and is never a valid audience.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "nelson-ai-mcp",
  title: "Nelson AI",
  version: "0.1.0",
  instructions:
    "Tools for the Nelson AI operations platform (NDI Office Furniture). All tools act as the signed-in Nelson AI user with the same row-level-security scope as the web app. Start with `whoami` to confirm the session, then use the domain tools (activity feed, AR aging) to answer questions or gather context.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [whoami, listRecentActivity, listArAging],
});
