import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

// Orders-focused recipients we monitor for delivery / bounce visibility.
const ORDER_RECIPIENT_PATTERNS = ["order", "toorders"];

function isOrderRecipient(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  return ORDER_RECIPIENT_PATTERNS.some((p) => a.includes(p));
}

export const getEmailMonitorStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      days: z.number().int().min(1).max(180).default(30),
      ordersOnly: z.boolean().default(true),
    }).parse,
  )
  .handler(async ({ data }) => {
    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error } = await supabaseAdmin
      .from("inbound_emails")
      .select("id, from_addr, to_addr, subject, status, error, classification, received_at, attachments, raw_payload")
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);

    const filtered = (rows ?? []).filter((r) =>
      data.ordersOnly ? isOrderRecipient(r.to_addr) || r.classification === "purchase_order" : true,
    );

    // Daily series
    const seriesMap = new Map<string, { date: string; delivered: number; errors: number; dismissed: number }>();
    for (let i = 0; i < data.days; i++) {
      const d = new Date(Date.now() - (data.days - 1 - i) * 86400000).toISOString().slice(0, 10);
      seriesMap.set(d, { date: d, delivered: 0, errors: 0, dismissed: 0 });
    }
    let totalDelivered = 0;
    let totalErrors = 0;
    let totalDismissed = 0;
    let totalAttachments = 0;
    let totalAttachmentBytes = 0;

    const issues: Array<{
      id: string;
      received_at: string;
      from_addr: string;
      to_addr: string | null;
      subject: string | null;
      status: string;
      error: string | null;
      reason: string;
    }> = [];

    for (const r of filtered) {
      const day = (r.received_at ?? "").slice(0, 10);
      const bucket = seriesMap.get(day);
      const st = String(r.status ?? "");
      if (st === "error") {
        if (bucket) bucket.errors++;
        totalErrors++;
      } else if (st === "dismissed") {
        if (bucket) bucket.dismissed++;
        totalDismissed++;
      } else {
        if (bucket) bucket.delivered++;
        totalDelivered++;
      }

      const atts = Array.isArray(r.attachments) ? r.attachments : [];
      totalAttachments += atts.length;
      for (const a of atts as any[]) {
        const sz = Number(a?.size ?? a?.content_length ?? 0);
        if (Number.isFinite(sz)) totalAttachmentBytes += sz;
      }

      if (st === "error" || st === "dismissed") {
        let reason = r.error ?? "";
        const lower = (reason + " " + (r.subject ?? "")).toLowerCase();
        if (!reason) reason = st === "dismissed" ? "Dismissed / ignored event" : "Unknown error";
        let category = "Other";
        if (/too\s*long|too\s*large|size|exceeds|552|5\.3\.4/.test(lower)) category = "Oversized message";
        else if (/recipient_not_allowed|not allowed|unknown user|550|5\.1\.1/.test(lower)) category = "Recipient not allowed";
        else if (/timeout|timed out/.test(lower)) category = "Timeout";
        else if (/signature|unauthor/.test(lower)) category = "Auth / signature";
        else if (/parse|json|format/.test(lower)) category = "Parse error";
        issues.push({
          id: r.id,
          received_at: r.received_at!,
          from_addr: r.from_addr,
          to_addr: r.to_addr,
          subject: r.subject,
          status: st,
          error: r.error,
          reason: category,
        });
      }
    }

    // Reason breakdown
    const reasonCounts = new Map<string, number>();
    for (const i of issues) reasonCounts.set(i.reason, (reasonCounts.get(i.reason) ?? 0) + 1);
    const reasons = Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    return {
      series: Array.from(seriesMap.values()),
      totals: {
        delivered: totalDelivered,
        errors: totalErrors,
        dismissed: totalDismissed,
        total: filtered.length,
        attachments: totalAttachments,
        attachmentBytes: totalAttachmentBytes,
      },
      reasons,
      issues: issues.slice(0, 100),
    };
  });
