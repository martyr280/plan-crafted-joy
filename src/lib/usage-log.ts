import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

export type UsageEventType = "login" | "module_view" | "feature_action";

/**
 * Fire-and-forget usage logging. Never throws, never blocks the UI.
 * Adopt in a new module with a single line:
 *   logUsage("feature_action", "spiff", "spiff_report_export", { runId });
 */
export function logUsage(
  eventType: UsageEventType,
  module: string,
  action?: string | null,
  metadata: Record<string, unknown> = {},
): void {
  if (typeof window === "undefined") return;
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) return;
      await supabase.from("usage_events").insert({
        user_id: uid,
        event_type: eventType,
        module,
        action: action ?? null,
        metadata: metadata as never,
      });
    } catch {
      /* silent by design */
    }
  })();
}

const DEDUPE_MS = 5 * 60 * 1000;

/** Max one module_view per user per module per 5 minutes (per browser). */
function shouldLogModuleView(module: string): boolean {
  try {
    const key = `nelson.usage.mv.${module}`;
    const prev = Number(window.localStorage.getItem(key) ?? 0);
    const now = Date.now();
    if (now - prev < DEDUPE_MS) return false;
    window.localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

/** Log a module view on mount, debounced. */
export function useModuleView(module: string, metadata: Record<string, unknown> = {}) {
  useEffect(() => {
    if (!shouldLogModuleView(module)) return;
    logUsage("module_view", module, null, metadata);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module]);
}

/** One 'login' event per new sign-in, not per token refresh or reload. */
export function logLoginOnce(userId: string) {
  try {
    const key = "nelson.usage.login.session";
    if (window.sessionStorage.getItem(key) === userId) return;
    window.sessionStorage.setItem(key, userId);
  } catch {
    /* ignore */
  }
  logUsage("login", "auth");
}

const CT = "America/Chicago";

export function formatCentral(ts: string | null | undefined, withTime = true): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CT,
    year: "numeric",
    month: "short",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(d) + (withTime ? " CT" : "");
}
