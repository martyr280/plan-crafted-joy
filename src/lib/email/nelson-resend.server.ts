// Server-only helper: sends Nelson AI–branded emails via Resend.
// Used by user-admin server functions for invites and password resets.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const NAVY = "#0f1b3d";
const ORANGE = "#e85d3a";
const TEXT = "#1f2937";
const MUTED = "#64748b";
const BORDER = "#e5e7eb";

function fromAddress(): string {
  return process.env.NELSON_FROM_EMAIL || "Nelson AI <noreply@nelsonbot.ai>";
}

function brandedHtml(opts: { heading: string; intro: string; ctaLabel: string; ctaUrl: string; footnote?: string }) {
  const { heading, intro, ctaLabel, ctaUrl, footnote } = opts;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${NAVY};padding:24px 28px;">
          <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">
            Nelson <span style="color:${ORANGE};">AI</span>
          </div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:2px;">for NDI Office Furniture</div>
        </td></tr>
        <tr><td style="padding:32px 28px 8px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${NAVY};font-weight:600;">${heading}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${TEXT};">${intro}</p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td>
            <a href="${ctaUrl}" style="display:inline-block;background:${ORANGE};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">${ctaLabel}</a>
          </td></tr></table>
          <p style="margin:24px 0 0;font-size:13px;color:${MUTED};line-height:1.6;">
            Or paste this link into your browser:<br/>
            <span style="color:${NAVY};word-break:break-all;">${ctaUrl}</span>
          </p>
          ${footnote ? `<p style="margin:20px 0 0;font-size:13px;color:${MUTED};line-height:1.6;">${footnote}</p>` : ""}
        </td></tr>
        <tr><td style="padding:24px 28px 28px;border-top:1px solid ${BORDER};margin-top:24px;">
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5;">
            Sent by Nelson AI · NDI Office Furniture<br/>
            If you weren't expecting this email, you can safely ignore it.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendResend(to: string, subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const r = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend send failed [${r.status}]: ${body.slice(0, 300)}`);
  }
  return r.json();
}

export async function sendNelsonInviteEmail(to: string, actionUrl: string) {
  return sendResend(
    to,
    "You're invited to Nelson AI",
    brandedHtml({
      heading: "Welcome to Nelson AI",
      intro: "An administrator has invited you to access Nelson AI — the operations workspace for NDI Office Furniture. Click below to accept your invitation and set your password.",
      ctaLabel: "Accept invitation",
      ctaUrl: actionUrl,
      footnote: "This invitation link will expire in 24 hours.",
    })
  );
}

export async function sendNelsonPasswordResetEmail(to: string, actionUrl: string) {
  return sendResend(
    to,
    "Reset your Nelson AI password",
    brandedHtml({
      heading: "Reset your password",
      intro: "We received a request to reset your Nelson AI password. Click below to choose a new one. If you didn't request this, you can ignore this email.",
      ctaLabel: "Reset password",
      ctaUrl: actionUrl,
      footnote: "This link will expire in 1 hour.",
    })
  );
}
