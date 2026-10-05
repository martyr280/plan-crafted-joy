// Confirmed warehouse-manager invite, expressed over injected ports so it is testable
// with synthetic fakes. Order:
//   claim -> generate link -> stage (inactive) -> begin send (durable "mail may go out" marker)
//   -> send -> mark sent (activates mapping).
// Before "begin send" any failure is safely retryable: no mail can have left.
// After it, only a definite provider rejection is retryable. Anything else (lost response,
// worker crash, activation write failure) becomes needs_reconciliation: access stays off and
// an admin must either finish activation (provider receipt recorded) or explicitly send a
// fresh invite acknowledging a possible duplicate email. The action link never leaves this
// function and is never stored, so a lost send is never "retried" with a different payload
// under the same provider idempotency key.
import { WAREHOUSES } from "./warehouse-scope";

export type InviteRequest = {
  actorId: string;
  inviteId: string;
  requestKey: string;
  email: string;
  warehouse: string;
  /** Admin acknowledged that a previous attempt may already have delivered an email. */
  ackDuplicate?: boolean;
};
export type ClaimResult =
  | { outcome: "claimed"; resend_key: string; user_id: string | null; display_name: string | null }
  | { outcome: "already_sent" }
  | { outcome: "in_progress" }
  | { outcome: "needs_reconciliation" };

export interface InviteDbPort {
  claim(r: InviteRequest): Promise<ClaimResult>;
  stage(inviteId: string, requestKey: string, userId: string): Promise<void>;
  beginSend(inviteId: string, requestKey: string): Promise<void>;
  markSent(inviteId: string, requestKey: string, providerId: string): Promise<void>;
  /** Returns the resulting status ('failed' | 'needs_reconciliation'), or null if stale. */
  markFailed(
    inviteId: string,
    requestKey: string,
    code: FailureCode,
    providerId?: string | null,
  ): Promise<string | null>;
}
export interface InviteAuthPort {
  findUserIdByEmail(email: string): Promise<string | null>;
  generateLink(
    email: string,
    displayName: string | null,
    existingUserId: string | null,
  ): Promise<{ userId: string; email: string; actionLink: string }>;
}
export interface InviteMailPort {
  /** Resolves with the provider message id. Throws { kind: "unknown" | "definite" } on failure. */
  send(
    to: string,
    actionLink: string,
    idempotencyKey: string,
    warehouse: string,
  ): Promise<{ id: string }>;
}

export type FailureCode =
  | "unknown_outcome"
  | "link_failed"
  | "user_mismatch"
  | "existing_account"
  | "existing_privileged_account"
  | "user_mapped_elsewhere"
  | "send_failed"
  | "stage_failed"
  | "activation_failed";
export type InviteOutcome =
  | { status: "sent"; duplicate: boolean }
  | { status: "in_progress" }
  | { status: "failed"; code: FailureCode }
  | { status: "needs_reconciliation"; code: FailureCode | "previous_attempt_unresolved" };

export function normalizeEmail(raw: string): string {
  const e = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (e.length > 255 || !/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e))
    throw new Error("invalid_email");
  return e;
}

const STAGE_CODES: FailureCode[] = [
  "user_mismatch",
  "existing_account",
  "existing_privileged_account",
  "user_mapped_elsewhere",
];
function stageCode(e: unknown): FailureCode {
  const m = String((e as { message?: unknown })?.message ?? "");
  return STAGE_CODES.find((c) => m.includes(c)) ?? "stage_failed";
}

export async function runConfirmedInvite(
  req: InviteRequest,
  ports: { db: InviteDbPort; auth: InviteAuthPort; mail: InviteMailPort },
): Promise<InviteOutcome> {
  const email = normalizeEmail(req.email);
  if (!(WAREHOUSES as readonly string[]).includes(req.warehouse))
    throw new Error("invalid_warehouse");
  if (!/^[0-9a-f-]{36}$/i.test(req.requestKey)) throw new Error("invalid_request_key");

  const claim = await ports.db.claim({ ...req, email });
  if (claim.outcome === "already_sent") return { status: "sent", duplicate: true };
  if (claim.outcome === "in_progress") return { status: "in_progress" };
  if (claim.outcome === "needs_reconciliation")
    return { status: "needs_reconciliation", code: "previous_attempt_unresolved" };

  // Pre-send failure: nothing was mailed, plain retry is safe.
  const fail = async (code: FailureCode): Promise<InviteOutcome> => {
    await ports.db.markFailed(req.inviteId, req.requestKey, code);
    return { status: "failed", code };
  };

  let existing: string | null = claim.user_id;
  if (!existing) {
    try {
      existing = await ports.auth.findUserIdByEmail(email);
    } catch {
      return fail("link_failed");
    }
  }

  let link: { userId: string; email: string; actionLink: string };
  try {
    link = await ports.auth.generateLink(email, claim.display_name, existing);
  } catch {
    return fail("link_failed");
  }
  if (!link?.userId || !link.actionLink || String(link.email ?? "").toLowerCase() !== email)
    return fail("user_mismatch");
  if (claim.user_id && link.userId !== claim.user_id) return fail("user_mismatch");

  try {
    await ports.db.stage(req.inviteId, req.requestKey, link.userId);
  } catch (e) {
    return fail(stageCode(e));
  }

  // Durable marker BEFORE mail: if this worker dies from here on, claim expiry turns the
  // row into needs_reconciliation instead of a silent resend.
  try {
    await ports.db.beginSend(req.inviteId, req.requestKey);
  } catch {
    return fail("stage_failed");
  }

  let receipt: { id: string };
  try {
    receipt = await ports.mail.send(email, link.actionLink, claim.resend_key, req.warehouse);
  } catch (e) {
    const definite = (e as { kind?: string })?.kind === "definite";
    const code: FailureCode = definite ? "send_failed" : "unknown_outcome";
    const status = await ports.db.markFailed(req.inviteId, req.requestKey, code).catch(() => null);
    // If even that write fails the row stays "sending" and expiry reconciles it.
    return definite && status === "failed"
      ? { status: "failed", code }
      : { status: "needs_reconciliation", code: "unknown_outcome" };
  }

  try {
    await ports.db.markSent(req.inviteId, req.requestKey, receipt.id);
  } catch {
    // Email was accepted but activation did not commit. Record the receipt so an admin can
    // finish activation without sending again. Access stays off meanwhile.
    await ports.db
      .markFailed(req.inviteId, req.requestKey, "activation_failed", receipt.id)
      .catch(() => null);
    return { status: "needs_reconciliation", code: "activation_failed" };
  }
  return { status: "sent", duplicate: false };
}
