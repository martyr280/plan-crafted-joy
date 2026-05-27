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
      const actionUrl = linkData?.properties?.action_link;
      if (actionUrl) {
        await sendNelsonPasswordResetEmail(data.email, actionUrl);
      }
    } catch (e: any) {
      console.error("requestPasswordReset error:", e?.message ?? e);
    }
    return { ok: true };
  });
