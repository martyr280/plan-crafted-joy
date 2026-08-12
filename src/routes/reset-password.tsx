import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function establish() {
      const url = new URL(window.location.href);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));

      // 1) Our own emailed link: ?token_hash=...&type=recovery
      const tokenHash = url.searchParams.get("token_hash") ?? hash.get("token_hash");
      if (tokenHash) {
        const { error } = await supabase.auth.verifyOtp({ type: "recovery", token_hash: tokenHash });
        if (cancelled) return;
        if (error) {
          setLinkError(error.message || "This password reset link is no longer valid.");
          return;
        }
        window.history.replaceState({}, "", "/reset-password");
        setReady(true);
        return;
      }

      // 2) Legacy Supabase verify redirect: #access_token=...&refresh_token=...
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (cancelled) return;
        if (error) {
          setLinkError(error.message || "This password reset link is no longer valid.");
          return;
        }
        window.history.replaceState({}, "", "/reset-password");
        setReady(true);
        return;
      }

      // 3) Error handed back by Supabase in the URL
      const urlError = hash.get("error_description") ?? url.searchParams.get("error_description");
      if (urlError) {
        setLinkError(decodeURIComponent(urlError));
        return;
      }

      // 4) Fall back to an already-established session (poll briefly instead
      //    of assuming the client finished parsing the URL within 100ms).
      for (let i = 0; i < 20; i++) {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        if (data.session) {
          setReady(true);
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!cancelled) {
        setLinkError("This password reset link is invalid or has already been used.");
      }
    }

    void establish();
    return () => {
      cancelled = true;
    };
  }, []);


  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) return toast.error("Password must be at least 8 characters.");
    if (password !== confirm) return toast.error("Passwords do not match.");
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Password updated. You're signed in.");
    navigate({ to: "/" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>Choose a strong password for your Nelson AI account.</CardDescription>
        </CardHeader>
        <CardContent>
          {linkError ? (
            <div className="space-y-4">
              <p className="text-sm text-destructive">{linkError}</p>
              <p className="text-sm text-muted-foreground">
                Reset links can only be used once and expire after 1 hour. Request a new one and open it in the
                same browser you requested it from.
              </p>
              <Button className="w-full" onClick={() => navigate({ to: "/auth", search: { next: "" } })}>
                Request a new reset link
              </Button>
            </div>
          ) : !ready ? (
            <div className="text-sm text-muted-foreground">Validating reset link…</div>
          ) : (

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <Label>New password</Label>
                <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div>
                <Label>Confirm password</Label>
                <Input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button className="w-full" disabled={saving}>{saving ? "Saving…" : "Update password"}</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
