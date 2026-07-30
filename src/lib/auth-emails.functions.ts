import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendNelsonMagicLinkEmail, sendNelsonPasswordResetEmail } from "./email/nelson-resend.server";

function appOrigin(): string {
  return process.env.PUBLIC_APP_URL || "https://www.nelsonbot.ai";
}

const EmailInput = z.object({ email: z.string().trim().toLowerCase().email().max(255) });

/**
 * Self-serve magic link. Generates a magiclink action URL via the admin API
 * and sends it through Resend. Always returns ok=true to avoid leaking
 * whether an account exists.
 */
export const requestMagicLink = createServerFn({ method: "POST" })
  .inputValidator((input) => EmailInput.parse(input))
  .handler(async ({ data }) => {
    const origin = appOrigin();
    try {
      const { data: linkData, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email: data.email,
        options: { redirectTo: `${origin}/` },
      });
      if (error) {
        console.error("generateLink(magiclink) failed:", error.message);
        return { ok: true };
      }
      const actionUrl = linkData?.properties?.action_link;
      if (actionUrl) {
        await sendNelsonMagicLinkEmail(data.email, actionUrl);
      }
    } catch (e: any) {
      console.error("requestMagicLink error:", e?.message ?? e);
    }
    return { ok: true };
  });

/**
 * Self-serve password reset. Generates a recovery action URL via the admin
 * API and sends it through Resend. Always returns ok=true.
 */
export const requestPasswordReset = createServerFn({ method: "POST" })
  .inputValidator((input) => EmailInput.parse(input))
  .handler(async ({ data }) => {
    const origin = appOrigin();
    try {
      const { data: linkData, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email: data.email,
        options: { redirectTo: `${origin}/reset-password` },
      });
      if (error) {
        console.error("generateLink(recovery) failed:", error.message);
        return { ok: true };
      }
      // Prefer the hashed token over Supabase's /auth/v1/verify action_link:
      // that link is single-use and is frequently consumed by corporate email
      // security scanners / link prefetchers before the user ever clicks it,
      // which is what produces the immediate "link has expired" message.
      // Sending users straight to our own page lets the browser exchange the
      // token itself via verifyOtp().
      const hashedToken = linkData?.properties?.hashed_token;
      const actionUrl = hashedToken
        ? `${origin}/reset-password?token_hash=${encodeURIComponent(hashedToken)}&type=recovery`
        : linkData?.properties?.action_link;
      if (actionUrl) {
        await sendNelsonPasswordResetEmail(data.email, actionUrl);
      }
    } catch (e: any) {
      console.error("requestPasswordReset error:", e?.message ?? e);
    }
    return { ok: true };
  });
