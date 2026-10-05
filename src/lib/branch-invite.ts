// Confirmed warehouse-manager invite, expressed over injected ports so it is testable
// with synthetic fakes. Order: claim -> generate link -> verify user -> stage (inactive)
// -> send (provider idempotency) -> mark sent (activates mapping). Any failure marks the
// operation failed, leaves the mapping inactive, and is retryable. The action link never
// leaves this function (not returned, not logged).
import { WAREHOUSES } from "./warehouse-scope";

export type InviteRequest = { actorId: string; inviteId: string; requestKey: string; email: string; warehouse: string };
export type ClaimResult =
  | { outcome: "claimed"; resend_key: string; user_id: string | null; display_name: string | null }
  | { outcome: "already_sent" }
  | { outcome: "in_progress" };

export interface InviteDbPort {
  claim(r: InviteRequest): Promise<ClaimResult>;
  stage(inviteId: string, requestKey: string, userId: string): Promise<void>;
  markSent(inviteId: string, requestKey: string): Promise<void>;
  markFailed(inviteId: string, requestKey: string, code: FailureCode): Promise<void>;
}
export interface InviteAuthPort {
  findUserIdByEmail(email: string): Promise<string | null>;
  generateLink(email: string, displayName: string | null, existingUserId: string | null): Promise<{ userId: string; email: string; actionLink: string }>;
}
export interface InviteMailPort {
  /** Throws { kind: "unknown" | "definite" } on failure. */
  send(to: string, actionLink: string, idempotencyKey: string, warehouse: string): Promise<void>;
}

export type FailureCode = "unknown_outcome" | "link_failed" | "user_mismatch" | "existing_account" | "existing_privileged_account" | "user_mapped_elsewhere" | "send_failed" | "stage_failed";
export type InviteOutcome =
  | { status: "sent"; duplicate: boolean }
  | { status: "in_progress" }
  | { status: "failed"; code: FailureCode };

export function normalizeEmail(raw: string): string {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length > 255 || !/^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new Error("invalid_email");
  return e;
}

const STAGE_CODES: FailureCode[] = ["user_mismatch", "existing_account", "existing_privileged_account", "user_mapped_elsewhere"];
function stageCode(e: unknown): FailureCode {
  const m = String((e as any)?.message ?? "");
  return STAGE_CODES.find((c) => m.includes(c)) ?? "stage_failed";
}

export async function runConfirmedInvite(req: InviteRequest, ports: { db: InviteDbPort; auth: InviteAuthPort; mail: InviteMailPort }): Promise<InviteOutcome> {
  const email = normalizeEmail(req.email);
  if (!(WAREHOUSES as readonly string[]).includes(req.warehouse)) throw new Error("invalid_warehouse");
  if (!/^[0-9a-f-]{36}$/i.test(req.requestKey)) throw new Error("invalid_request_key");

  const claim = await ports.db.claim({ ...req, email });
  if (claim.outcome === "already_sent") return { status: "sent", duplicate: true };
  if (claim.outcome === "in_progress") return { status: "in_progress" };

  const fail = async (code: FailureCode): Promise<InviteOutcome> => {
    await ports.db.markFailed(req.inviteId, req.requestKey, code);
    return { status: "failed", code };
  };

  // Never convert someone's existing login into a branch account.
  if (!claim.user_id) {
    let existing: string | null;
    try { existing = await ports.auth.findUserIdByEmail(email); } catch { return fail("link_failed"); }
    if (existing) return fail("existing_account");
  }

  let link: { userId: string; email: string; actionLink: string };
  try { link = await ports.auth.generateLink(email, claim.display_name, claim.user_id); } catch { return fail("link_failed"); }
  if (!link?.userId || !link.actionLink || String(link.email ?? "").toLowerCase() !== email) return fail("user_mismatch");
  if (claim.user_id && link.userId !== claim.user_id) return fail("user_mismatch");

  try { await ports.db.stage(req.inviteId, req.requestKey, link.userId); } catch (e) { return fail(stageCode(e)); }

  try {
    await ports.mail.send(email, link.actionLink, claim.resend_key, req.warehouse);
  } catch (e: any) {
    return fail(e?.kind === "definite" ? "send_failed" : "unknown_outcome");
  }

  try {
    await ports.db.markSent(req.inviteId, req.requestKey);
  } catch {
    // Mail may be out but access stays inactive; keep the same provider key for the retry.
    return fail("unknown_outcome");
  }
  return { status: "sent", duplicate: false };
}
