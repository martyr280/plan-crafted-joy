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
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Supabase puts the recovery session in the URL hash; the JS client
    // auto-detects it. Wait one tick, then verify we have a session.
    const t = setTimeout(async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        toast.error("This password reset link is invalid or has expired.");
        navigate({ to: "/auth" });
        return;
      }
      setReady(true);
    }, 100);
    return () => clearTimeout(t);
  }, [navigate]);

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
          {!ready ? (
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
