import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// The Supabase OAuth authorization-server helpers are in a beta namespace
// that isn't fully typed on the current client version. Wrap the three
// methods we call so the rest of this file stays typed.
type AuthorizationClient = {
  name?: string | null;
  icon_uri?: string | null;
  client_uri?: string | null;
};
type AuthorizationDetails = {
  client?: AuthorizationClient | null;
  scopes?: string[] | null;
  redirect_url?: string | null;
  redirect_to?: string | null;
};
type OAuthResult<T = AuthorizationDetails> = {
  data: T | null;
  error: { message: string } | null;
};
type SupabaseOAuth = {
  getAuthorizationDetails(id: string): Promise<OAuthResult<AuthorizationDetails>>;
  approveAuthorization(id: string): Promise<OAuthResult<AuthorizationDetails>>;
  denyAuthorization(id: string): Promise<OAuthResult<AuthorizationDetails>>;
};
function oauthClient(): SupabaseOAuth {
  return (supabase.auth as unknown as { oauth: SupabaseOAuth }).oauth;
}

export const Route = createFileRoute("/.lovable/oauth/consent")({
  // Browser-only: the Supabase client reads its session from localStorage,
  // which is absent during SSR. Without this, a signed-in user is treated
  // as unauthenticated during the server pass and bounced to /auth.
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const next = location.pathname + location.searchStr;
      throw redirect({ to: "/auth", search: { next } });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.searchStr).get("authorization_id")!;
    const { data, error } = await oauthClient().getAuthorizationDetails(authorizationId);
    if (error) throw new Error(error.message);
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="min-h-screen flex items-center justify-center p-8 bg-background">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-lg font-semibold">We couldn't load this authorization request</h1>
        <p className="text-sm text-muted-foreground">
          {(error as Error)?.message ?? String(error)}
        </p>
        <a href="/" className="text-sm text-accent hover:underline">
          Return to Nelson AI
        </a>
      </div>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setError(null);
    setBusy(approve ? "approve" : "deny");
    const client = oauthClient();
    const res = approve
      ? await client.approveAuthorization(authorization_id)
      : await client.denyAuthorization(authorization_id);
    if (res.error) {
      setBusy(null);
      setError(res.error.message);
      return;
    }
    const target = res.data?.redirect_url ?? res.data?.redirect_to;
    if (!target) {
      setBusy(null);
      setError("The authorization server did not return a redirect URL.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name?.trim() || "An external application";
  const scopes = details?.scopes ?? [];

  return (
    <main className="min-h-screen flex items-center justify-center p-8 bg-background">
      <div className="w-full max-w-md rounded-lg border bg-card shadow-[var(--shadow-elegant)] p-8 space-y-6">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Nelson AI</p>
          <h1 className="text-xl font-semibold leading-tight">
            Connect {clientName} to your account
          </h1>
          <p className="text-sm text-muted-foreground">
            {clientName} will be able to call Nelson AI's enabled tools while you are signed in.
            It acts as you, and all row-level-security rules of the Nelson AI app still apply.
          </p>
        </div>

        {scopes.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Requested access</p>
            <ul className="text-sm space-y-1">
              {scopes.map((s) => (
                <li key={s} className="text-foreground">
                  • {s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div role="alert" className="text-sm text-destructive border border-destructive/40 rounded p-2">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => decide(true)}
            className="flex-1 inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-medium h-10 px-4 disabled:opacity-60"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => decide(false)}
            className="flex-1 inline-flex items-center justify-center rounded-md border text-sm font-medium h-10 px-4 disabled:opacity-60"
          >
            {busy === "deny" ? "Cancelling…" : "Cancel"}
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          This does not bypass Nelson AI's permissions or backend policies.
        </p>
      </div>
    </main>
  );
}
