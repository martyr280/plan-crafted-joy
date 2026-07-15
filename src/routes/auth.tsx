import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { requestMagicLink, requestPasswordReset } from "@/lib/auth-emails.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import nelsonAiLogo from "@/assets/nelson-ai-logo.png";


export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === "string" ? s.next : "",
  }),
  component: AuthPage,
});

// Only allow same-origin relative paths as post-auth destinations.
function safeNext(next: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function AuthPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const dest = safeNext(next);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [magicEmail, setMagicEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  const sendMagicLink = useServerFn(requestMagicLink);
  const sendPasswordReset = useServerFn(requestPasswordReset);


  useEffect(() => {
    setMounted(true);
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        if (dest === "/") navigate({ to: "/" });
        else window.location.href = dest;
      }
    });
  }, [navigate, dest]);

  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    );
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    if (dest === "/") navigate({ to: "/" });
    else window.location.href = dest;
  }

  async function signUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const emailRedirect =
      dest === "/" ? `${window.location.origin}/` : `${window.location.origin}${dest}`;
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { emailRedirectTo: emailRedirect, data: { display_name: name } },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Check your email to confirm your account.");
  }

  async function magicLink(e: React.FormEvent) {
    e.preventDefault();
    setMagicLoading(true);
    try {
      await sendMagicLink({ data: { email: magicEmail } });
      toast.success("Check your email for the sign-in link.");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to send magic link.");
    } finally {
      setMagicLoading(false);
    }
  }

  async function forgotPassword() {
    if (!email) return toast.error("Enter your email above first.");
    setResetLoading(true);
    try {
      await sendPasswordReset({ data: { email } });
      toast.success("If an account exists, a reset link has been sent.");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to send reset email.");
    } finally {
      setResetLoading(false);
    }
  }


  async function googleSignIn() {
    const { lovable } = await import("@/integrations/lovable/index");
    // Return to /auth so the useEffect above can consume `next` after the
    // session is set — required for OAuth-consent handoff.
    const redirectUri =
      dest === "/"
        ? window.location.origin
        : `${window.location.origin}/auth?next=${encodeURIComponent(dest)}`;
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: redirectUri,
    });
    if (result.error) {
      toast.error(result.error.message ?? "Google sign-in failed");
      return;
    }
    if (result.redirected) return;
    if (dest === "/") navigate({ to: "/" });
    else window.location.href = dest;
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      <div
        className="hidden lg:flex flex-col justify-between p-12 text-primary-foreground relative overflow-hidden"
        style={{ background: "var(--gradient-primary)" }}
      >
        <div
          aria-hidden
          className="absolute -top-32 -right-32 w-96 h-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "var(--gradient-accent)" }}
        />
        <div className="flex items-center gap-3 relative">
          <img src={nelsonAiLogo} alt="Nelson AI" width={44} height={44} className="w-11 h-11 rounded-lg shadow-[var(--shadow-glow)]" />
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold tracking-tight">Nelson AI</span>
            <span className="text-xs text-primary-foreground/70">for NDI Office Furniture</span>
          </div>
        </div>
        <div className="relative">
          <h1 className="text-4xl font-bold leading-tight tracking-tight">Operations, unified.</h1>
          <p className="mt-4 text-primary-foreground/80 max-w-md">
            Order intake, sales, logistics, AR, SPIFF and reports — one workspace replacing the spreadsheets and Web Connect.
          </p>
        </div>
        <p className="text-sm text-primary-foreground/60 relative">© Nelson AI · Internal use only</p>
      </div>

      <div className="flex items-center justify-center p-8">
        <Card className="w-full max-w-md shadow-[var(--shadow-elegant)]">
          <CardHeader>
            <CardTitle>Welcome</CardTitle>
            <CardDescription>Sign in to Nelson AI</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin">
              <TabsList className="grid grid-cols-2 w-full">
                <TabsTrigger value="signin">Sign in</TabsTrigger>
                <TabsTrigger value="signup">Sign up</TabsTrigger>
              </TabsList>
              <TabsContent value="signin">
                <form onSubmit={signIn} className="space-y-4 mt-4">
                  <div><Label>Email</Label><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
                  <div><Label>Password</Label><Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
                  <Button className="w-full" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</Button>
                  <button
                    type="button"
                    onClick={forgotPassword}
                    disabled={resetLoading}
                    className="text-xs text-muted-foreground hover:text-foreground underline w-full text-center"
                  >
                    {resetLoading ? "Sending…" : "Forgot password?"}
                  </button>
                </form>
              </TabsContent>

              <TabsContent value="signup">
                <form onSubmit={signUp} className="space-y-4 mt-4">
                  <div><Label>Display name</Label><Input required value={name} onChange={(e) => setName(e.target.value)} /></div>
                  <div><Label>Email</Label><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
                  <div><Label>Password</Label><Input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
                  <Button className="w-full" disabled={loading}>{loading ? "Creating…" : "Create account"}</Button>
                </form>
              </TabsContent>
            </Tabs>
            <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px bg-border flex-1" /> OR <div className="h-px bg-border flex-1" />
            </div>
            <div className="space-y-3">
              <Button variant="outline" className="w-full" onClick={googleSignIn}>Continue with Google</Button>
              <form onSubmit={magicLink} className="space-y-2">
                <Label htmlFor="magic-email">Magic link</Label>
                <div className="flex gap-2">
                  <Input
                    id="magic-email"
                    type="email"
                    placeholder="you@example.com"
                    required
                    value={magicEmail}
                    onChange={(e) => setMagicEmail(e.target.value)}
                  />
                  <Button type="submit" variant="secondary" disabled={magicLoading}>
                    {magicLoading ? "Sending…" : "Send link"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">We'll email you a one-click sign-in link.</p>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
