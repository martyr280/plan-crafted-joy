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

export async function sendNelsonMagicLinkEmail(to: string, actionUrl: string) {
  return sendResend(
    to,
    "Your Nelson AI sign-in link",
    brandedHtml({
      heading: "Sign in to Nelson AI",
      intro: "Click the button below to sign in. If you didn't request this, you can safely ignore this email.",
      ctaLabel: "Sign in",
      ctaUrl: actionUrl,
      footnote: "This link will expire in 1 hour and can only be used once.",
    })
  );
}

export async function sendNelsonCredentialsEmail(to: string, password: string, signInUrl: string) {
  const html = `<!doctype html>
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
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${NAVY};font-weight:600;">Your Nelson AI account is ready</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT};">
            An administrator has created an account for you. Use the credentials below to sign in. We recommend changing your password after your first login.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f8fafc;border:1px solid ${BORDER};border-radius:8px;margin:0 0 24px;">
            <tr><td style="padding:14px 18px;border-bottom:1px solid ${BORDER};">
              <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Email</div>
              <div style="font-size:15px;color:${NAVY};font-weight:500;">${to}</div>
            </td></tr>
            <tr><td style="padding:14px 18px;">
              <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Temporary password</div>
              <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:15px;color:${NAVY};font-weight:600;letter-spacing:0.02em;">${password}</div>
            </td></tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td>
            <a href="${signInUrl}" style="display:inline-block;background:${ORANGE};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px;">Sign in to Nelson AI</a>
          </td></tr></table>
          <p style="margin:24px 0 0;font-size:13px;color:${MUTED};line-height:1.6;">
            For your security, change your password after signing in by using "Forgot password?" on the sign-in screen.
          </p>
        </td></tr>
        <tr><td style="padding:24px 28px 28px;border-top:1px solid ${BORDER};margin-top:24px;">
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5;">
            Sent by Nelson AI · NDI Office Furniture<br/>
            If you weren't expecting this email, please contact your administrator.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return sendResend(to, "Your Nelson AI account credentials", html);
}




// ---------------------------------------------------------------------------
// Capacity alerts (Truck Capacity module)
// ---------------------------------------------------------------------------

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function statRow(label: string, value: string) {
  return `<tr>
    <td style="padding:10px 14px;border-bottom:1px solid ${BORDER};font-size:13px;color:${MUTED};">${label}</td>
    <td style="padding:10px 14px;border-bottom:1px solid ${BORDER};font-size:15px;color:${NAVY};font-weight:600;text-align:right;">${value}</td>
  </tr>`;
}

export type CapacityAlertEmailData = {
  repName: string;
  routeCode: string;
  routeName: string;
  thresholdPct: number;
  streakDays: number;
  streakFrom: string;
  streakTo: string;
  avgInStreak: number | null;
  avgMonth: number | null;
  avgQuarter: number | null;
  avgYear: number | null;
};

export async function sendCapacityAlertEmail(to: string, d: CapacityAlertEmailData) {
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${NAVY};padding:24px 28px;">
          <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Nelson <span style="color:${ORANGE};">AI</span></div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:2px;">Truck Capacity alert</div>
        </td></tr>
        <tr><td style="padding:32px 28px 8px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${NAVY};font-weight:600;">
            ${d.routeCode} has run under ${d.thresholdPct}% for ${d.streakDays} days straight
          </h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${TEXT};">
            Hi ${d.repName} — route <strong>${d.routeCode}</strong>${d.routeName ? ` (${d.routeName})` : ""} averaged
            <strong>${pct(d.avgInStreak)}</strong> capacity across ${d.streakDays} consecutive delivery days
            (${d.streakFrom} to ${d.streakTo}), below the ${d.thresholdPct}% target. Here's how that compares
            to your longer-run averages:
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f8fafc;border:1px solid ${BORDER};border-radius:8px;margin:0 0 24px;">
            ${statRow("This streak", pct(d.avgInStreak))}
            ${statRow("This month to date", pct(d.avgMonth))}
            ${statRow("Past quarter (90 days)", pct(d.avgQuarter))}
            ${statRow("Past 12 months", pct(d.avgYear))}
          </table>
          <p style="margin:0;font-size:14px;line-height:1.6;color:${TEXT};">
            Underfilled trucks running to your customers cost margin on every stop. Please review what's
            scheduled on this route and consolidate where you can.
          </p>
        </td></tr>
        <tr><td style="padding:24px 28px 28px;border-top:1px solid ${BORDER};">
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5;">
            Sent automatically by Nelson AI · NDI Office Furniture<br/>
            Capacity thresholds and alert frequency are managed by your logistics admin.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return sendResend(to, `Capacity alert: ${d.routeCode} under ${d.thresholdPct}% for ${d.streakDays} days`, html);
}

export type CapacityDigestEmailData = {
  ruleName: string;
  thresholdPct: number;
  rows: Array<{
    routeCode: string;
    routeName: string;
    reps: string[];
    streakDays: number;
    avgInStreak: number | null;
    avgMonth: number | null;
    avgQuarter: number | null;
    avgYear: number | null;
  }>;
};

export async function sendCapacityDigestEmail(to: string[], d: CapacityDigestEmailData) {
  const rows = d.rows.map((r) => `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${NAVY};font-weight:600;">${r.routeCode}<div style="font-weight:400;color:${MUTED};font-size:12px;">${r.routeName ?? ""}</div></td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};">${r.reps.length ? r.reps.join(", ") : "<em>unassigned</em>"}</td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};text-align:center;">${r.streakDays}d</td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};text-align:right;">${pct(r.avgInStreak)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};text-align:right;">${pct(r.avgMonth)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};text-align:right;">${pct(r.avgQuarter)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};text-align:right;">${pct(r.avgYear)}</td>
  </tr>`).join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="720" cellpadding="0" cellspacing="0" style="max-width:720px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${NAVY};padding:24px 28px;">
          <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Nelson <span style="color:${ORANGE};">AI</span></div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:2px;">Daily capacity alert digest</div>
        </td></tr>
        <tr><td style="padding:28px 28px 8px;">
          <h1 style="margin:0 0 8px;font-size:20px;color:${NAVY};font-weight:600;">${d.rows.length} route(s) alerted — ${d.ruleName}</h1>
          <p style="margin:0 0 20px;font-size:14px;color:${TEXT};line-height:1.6;">
            Routes below the ${d.thresholdPct}% threshold for their configured consecutive-day streak.
            Salespeople listed have been notified unless marked opted out or at their weekly cap.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid ${BORDER};border-radius:8px;border-collapse:collapse;">
            <tr style="background:#f8fafc;">
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">Route</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">Rep(s)</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">Streak</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">Streak avg</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">Month</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">Quarter</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};">12 mo</th>
            </tr>
            ${rows}
          </table>
        </td></tr>
        <tr><td style="padding:24px 28px 28px;border-top:1px solid ${BORDER};">
          <p style="margin:0;font-size:12px;color:${MUTED};line-height:1.5;">Sent automatically by Nelson AI · NDI Office Furniture</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const r = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: fromAddress(), to, subject: `Capacity alert digest — ${d.rows.length} route(s) underfilled`, html }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend digest send failed [${r.status}]: ${body.slice(0, 300)}`);
  }
  return r.json();
}
