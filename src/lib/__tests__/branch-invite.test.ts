// Synthetic-only: fake auth, mail and database ports that mirror migration 0009
// (bm_claim / bm_stage / bm_begin_send / bm_mark_sent / bm_mark_failed /
// bm_finish_activation / handle_new_user). No network, no real accounts, no email.
import { describe, it, expect, beforeEach } from "vitest";
import {
  runConfirmedInvite,
  normalizeEmail,
  type InviteDbPort,
  type InviteAuthPort,
  type InviteMailPort,
  type InviteOutcome,
} from "../branch-invite";

type Inv = {
  id: string;
  email: string;
  warehouse: string;
  status: string;
  user_id: string | null;
  created_user_id: string | null;
  request_key: string | null;
  resend_key: string | null;
  last_error: string | null;
  display_name: string | null;
  claim_expires_at: number | null;
  provider_message_id: string | null;
};

const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";
const K3 = "33333333-3333-4333-8333-333333333333";
const TTL = 10 * 60_000;

function world() {
  let now = 1_000_000;
  const invites = new Map<string, Inv>();
  const roles = new Map<string, Set<string>>();
  const mapping = new Map<string, { warehouse: string; active: boolean; invite: string }>();
  const users = new Map<string, { email: string }>();
  const mail: { to: string; key: string; link: string }[] = [];
  let seq = 0;
  invites.set("inv", {
    id: "inv",
    email: "pat@example.test",
    warehouse: "Dallas",
    status: "draft",
    user_id: null,
    created_user_id: null,
    request_key: null,
    resend_key: null,
    last_error: null,
    display_name: "Pat",
    claim_expires_at: null,
    provider_message_id: null,
  });
  const expired = (i: Inv) => i.claim_expires_at !== null && i.claim_expires_at <= now;
  const deactivate = (id: string) => {
    for (const m of mapping.values()) if (m.invite === id) m.active = false;
  };
  const activate = (i: Inv) => {
    const rs = roles.get(i.user_id ?? "") ?? new Set();
    if (!i.user_id || !rs.has("branch_manager") || [...rs].some((r) => r !== "branch_manager"))
      throw new Error("inconsistent_setup");
    const m = mapping.get(i.user_id);
    if (!m || m.invite !== i.id) throw new Error("inconsistent_setup");
    m.active = true;
  };
  const faults = { markSent: false, markFailed: false, beginSend: false };

  /** handle_new_user: claimed invite email -> bind, NO default ops_orders role. */
  function signupTrigger(id: string, email: string) {
    users.set(id, { email });
    const inv = [...invites.values()].find(
      (i) => i.email === email && i.status === "claimed" && !expired(i),
    );
    if (inv) inv.created_user_id = id;
    else roles.set(id, new Set(["ops_orders"]));
  }

  const db: InviteDbPort & { finish(id: string): Promise<string> } = {
    async claim(r) {
      const i = invites.get(r.inviteId)!;
      if (i.email !== r.email || i.warehouse !== r.warehouse) throw new Error("request_mismatch");
      if (i.status === "sent") return { outcome: "already_sent" };
      if (["cancelled", "revoked"].includes(i.status)) throw new Error("not_invitable");
      if (i.status === "sending" && expired(i)) {
        deactivate(i.id);
        Object.assign(i, {
          status: "needs_reconciliation",
          last_error: "unknown_outcome",
          claim_expires_at: null,
        });
        return { outcome: "needs_reconciliation" };
      }
      if (["claimed", "staged", "sending"].includes(i.status) && !expired(i)) {
        if (i.request_key === r.requestKey) return { outcome: "in_progress" };
        throw new Error("in_flight");
      }
      if (i.status === "needs_reconciliation" && !r.ackDuplicate)
        return { outcome: "needs_reconciliation" };
      Object.assign(i, {
        status: "claimed",
        request_key: r.requestKey,
        resend_key: `rk-${++seq}`,
        last_error: null,
        claim_expires_at: now + TTL,
        provider_message_id: null,
      });
      return {
        outcome: "claimed",
        resend_key: i.resend_key!,
        user_id: i.user_id,
        display_name: i.display_name,
      };
    },
    async stage(id, key, userId) {
      const i = invites.get(id)!;
      if (i.status !== "claimed" || i.request_key !== key || expired(i))
        throw new Error("stale_claim");
      const u = users.get(userId);
      if (!u || u.email !== i.email || (i.user_id && i.user_id !== userId))
        throw new Error("user_mismatch");
      if (!i.user_id && i.created_user_id !== userId) throw new Error("existing_account");
      const rs = roles.get(userId) ?? new Set();
      if ([...rs].some((x) => x !== "branch_manager"))
        throw new Error("existing_privileged_account");
      roles.set(userId, new Set(["branch_manager"]));
      mapping.set(userId, { warehouse: i.warehouse, active: false, invite: id });
      Object.assign(i, { status: "staged", user_id: userId });
    },
    async beginSend(id, key) {
      if (faults.beginSend) throw new Error("db down");
      const i = invites.get(id)!;
      if (i.status !== "staged" || i.request_key !== key || expired(i))
        throw new Error("stale_claim");
      Object.assign(i, { status: "sending", claim_expires_at: now + TTL });
    },
    async markSent(id, key, providerId) {
      if (faults.markSent) throw new Error("db down");
      const i = invites.get(id)!;
      if (i.status !== "sending" || i.request_key !== key) throw new Error("stale_claim");
      activate(i);
      Object.assign(i, { status: "sent", claim_expires_at: null, provider_message_id: providerId });
    },
    async markFailed(id, key, code, providerId) {
      if (faults.markFailed) throw new Error("db down");
      const i = invites.get(id)!;
      if (!["claimed", "staged", "sending"].includes(i.status) || i.request_key !== key)
        return null;
      const status =
        i.status === "sending" && code !== "send_failed" ? "needs_reconciliation" : "failed";
      deactivate(id);
      Object.assign(i, {
        status,
        last_error: code,
        claim_expires_at: null,
        provider_message_id: i.status === "sending" ? (providerId ?? null) : null,
      });
      return status;
    },
    async finish(id) {
      const i = invites.get(id)!;
      if (i.status === "sent") return "sent";
      if (i.status !== "needs_reconciliation" || !i.provider_message_id)
        throw new Error("not_confirmed_delivered");
      activate(i);
      Object.assign(i, { status: "sent", last_error: null });
      return "sent";
    },
  };

  const auth: InviteAuthPort & {
    calls: number;
    next?: (email: string) => { userId: string; email: string };
  } = {
    calls: 0,
    async findUserIdByEmail(email) {
      for (const [id, u] of users) if (u.email === email) return id;
      return null;
    },
    async generateLink(email, _n, existing) {
      auth.calls++;
      const o = auth.next?.(email);
      const id = existing ?? o?.userId ?? `user-${++seq}`;
      if (!users.has(id)) signupTrigger(id, o?.email ?? email);
      return {
        userId: id,
        email: o?.email ?? email,
        actionLink: `https://synthetic.invalid/verify?token=SECRET-${++seq}`,
      };
    },
  };

  // Fake provider with Resend idempotency semantics: same key + same payload => replay
  // (no second delivery); same key + DIFFERENT payload => 409 conflict.
  const byKey = new Map<string, string>();
  const mailPort: InviteMailPort & {
    mode: "ok" | "unknown_before" | "definite" | "lost_after_delivery";
    crashAfterDelivery?: boolean;
  } = {
    mode: "ok",
    async send(to, link, key) {
      if (mailPort.mode === "definite") throw Object.assign(new Error("x"), { kind: "definite" });
      if (mailPort.mode === "unknown_before")
        throw Object.assign(new Error("x"), { kind: "unknown" });
      const prior = byKey.get(key);
      if (prior !== undefined && prior !== link)
        throw Object.assign(new Error("409"), { kind: "unknown" });
      if (prior === undefined) {
        byKey.set(key, link);
        mail.push({ to, key, link });
      }
      if (mailPort.crashAfterDelivery) throw new Error("WORKER_CRASH");
      if (mailPort.mode === "lost_after_delivery")
        throw Object.assign(new Error("x"), { kind: "unknown" });
      return { id: `msg-${key}` };
    },
  };
  return {
    invites,
    roles,
    mapping,
    users,
    mail,
    db,
    auth,
    mailPort,
    faults,
    signupTrigger,
    advance: (ms: number) => (now += ms),
  };
}

const req = (key = K1, extra: Record<string, unknown> = {}) => ({
  actorId: "admin",
  inviteId: "inv",
  requestKey: key,
  email: " Pat@Example.TEST ",
  warehouse: "Dallas",
  ...extra,
});

describe("confirmed warehouse-manager invite (synthetic ports)", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });
  const ports = () => ({ db: w.db, auth: w.auth, mail: w.mailPort });
  const inv = () => w.invites.get("inv")!;
  const anyActive = () => [...w.mapping.values()].some((m) => m.active);

  it("normalizes email and rejects invalid input", () => {
    expect(normalizeEmail("  A.B@Ex.com ")).toBe("a.b@ex.com");
    expect(() => normalizeEmail("nope")).toThrow();
  });

  it("happy path: stages inactive, sends once, then activates; never returns the link", async () => {
    const out = await runConfirmedInvite(req(), ports());
    expect(out).toEqual({ status: "sent", duplicate: false });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|token/);
    expect(JSON.stringify(inv())).not.toMatch(/SECRET|token/);
    expect(w.mail).toHaveLength(1);
    const uid = inv().user_id!;
    expect(w.mapping.get(uid)).toMatchObject({ warehouse: "Dallas", active: true });
    expect([...w.roles.get(uid)!]).toEqual(["branch_manager"]);
    expect(inv().provider_message_id).toMatch(/^msg-/);
  });

  it("new invite account never holds the default operator role, even before staging", async () => {
    let rolesAtLink: string[] | null = null;
    const origStage = w.db.stage;
    w.db.stage = async (id, key, uid) => {
      rolesAtLink = [...(w.roles.get(uid) ?? [])];
      return origStage(id, key, uid);
    };
    await runConfirmedInvite(req(), ports());
    expect(rolesAtLink).toEqual([]);
    // An ordinary signup with no claimed invite still gets the default role.
    w.signupTrigger("walk-in", "someone@example.test");
    expect([...w.roles.get("walk-in")!]).toEqual(["ops_orders"]);
  });

  it("stage failure leaves the bound account with no role at all", async () => {
    w.db.stage = async () => {
      throw new Error("stage_failed");
    };
    expect(await runConfirmedInvite(req(), ports())).toEqual({
      status: "failed",
      code: "stage_failed",
    });
    const uid = [...w.users.keys()][0]!;
    expect(w.roles.get(uid)).toBeUndefined();
    expect(w.mail).toHaveLength(0);
  });

  it("repeated submit after success sends no second email", async () => {
    await runConfirmedInvite(req(), ports());
    expect(await runConfirmedInvite(req(), ports())).toEqual({ status: "sent", duplicate: true });
    expect(w.mail).toHaveLength(1);
    expect(w.auth.calls).toBe(1);
  });

  it("concurrent submits: exactly one email", async () => {
    const results = await Promise.allSettled([
      runConfirmedInvite(req(K1), ports()),
      runConfirmedInvite(req(K1), ports()),
      runConfirmedInvite(req(K2), ports()),
    ]);
    expect(w.mail).toHaveLength(1);
    expect(w.auth.calls).toBe(1);
    const ok = results
      .filter((r): r is PromiseFulfilledResult<InviteOutcome> => r.status === "fulfilled")
      .map((r) => r.value.status);
    expect(ok.filter((s) => s === "sent")).toHaveLength(1);
  });

  it("cancellation before dispatch has zero effects", async () => {
    inv().status = "cancelled";
    await expect(runConfirmedInvite(req(), ports())).rejects.toThrow(/not_invitable/);
    expect(w.auth.calls).toBe(0);
    expect(w.mail).toHaveLength(0);
    expect(w.users.size).toBe(0);
    expect(w.mapping.size).toBe(0);
  });

  it("warehouse or email cannot change under the same request", async () => {
    await expect(runConfirmedInvite(req(K1, { warehouse: "Ocala" }), ports())).rejects.toThrow(
      /request_mismatch/,
    );
    await expect(
      runConfirmedInvite(req(K1, { email: "other@example.test" }), ports()),
    ).rejects.toThrow(/request_mismatch/);
    expect(w.auth.calls).toBe(0);
  });

  it("response lost after delivery: fails closed to review, never auto-retries with a new link", async () => {
    w.mailPort.mode = "lost_after_delivery";
    expect(await runConfirmedInvite(req(K1), ports())).toEqual({
      status: "needs_reconciliation",
      code: "unknown_outcome",
    });
    expect(w.mail).toHaveLength(1); // it was in fact delivered
    expect(inv().status).toBe("needs_reconciliation");
    expect(anyActive()).toBe(false);
    // A plain retry does nothing: no new link, no email, no activation.
    w.mailPort.mode = "ok";
    const calls = w.auth.calls;
    expect(await runConfirmedInvite(req(K2), ports())).toEqual({
      status: "needs_reconciliation",
      code: "previous_attempt_unresolved",
    });
    expect(w.auth.calls).toBe(calls);
    expect(w.mail).toHaveLength(1);
    expect(anyActive()).toBe(false);
    // Finishing activation without a provider receipt is refused.
    await expect(w.db.finish("inv")).rejects.toThrow(/not_confirmed_delivered/);
  });

  it("explicitly acknowledged fresh invite uses a NEW provider key (no payload conflict)", async () => {
    w.mailPort.mode = "lost_after_delivery";
    await runConfirmedInvite(req(K1), ports());
    const k1 = inv().resend_key;
    w.mailPort.mode = "ok";
    const out = await runConfirmedInvite(req(K2, { ackDuplicate: true }), ports());
    expect(out.status).toBe("sent");
    expect(inv().resend_key).not.toBe(k1);
    expect(w.mail).toHaveLength(2); // the acknowledged possible duplicate
    expect(w.users.size).toBe(1); // same account, no orphan
    expect(anyActive()).toBe(true);
  });

  it("reusing an old provider key with a fresh link would conflict — documents why keys are never reused", async () => {
    w.mailPort.mode = "lost_after_delivery";
    await runConfirmedInvite(req(K1), ports());
    w.mailPort.mode = "ok";
    await expect(
      w.mailPort.send(
        "pat@example.test",
        "https://synthetic.invalid/other",
        inv().resend_key!,
        "Dallas",
      ),
    ).rejects.toMatchObject({ kind: "unknown" });
  });

  it("worker crash after delivery: claim expiry converts to review, not a resend", async () => {
    // Simulated crash: delivery happened, then no further DB write from this worker lands.
    w.mailPort.crashAfterDelivery = true;
    w.faults.markFailed = true;
    w.faults.markSent = true;
    await runConfirmedInvite(req(K1), ports());
    expect(inv().status).toBe("sending");
    expect(anyActive()).toBe(false);
    w.mailPort.crashAfterDelivery = false;
    w.faults.markFailed = false;
    w.faults.markSent = false;
    // Before expiry: another admin's request is refused as in-flight.
    await expect(runConfirmedInvite(req(K2), ports())).rejects.toThrow(/in_flight/);
    w.advance(TTL + 1);
    expect(await runConfirmedInvite(req(K2), ports())).toEqual({
      status: "needs_reconciliation",
      code: "previous_attempt_unresolved",
    });
    expect(inv().status).toBe("needs_reconciliation");
    expect(w.mail).toHaveLength(1);
    expect(anyActive()).toBe(false);
  });

  it("worker crash before sending (staged, expired) is a safe plain retry with one email", async () => {
    w.faults.beginSend = true;
    const origFail = w.db.markFailed;
    w.db.markFailed = async () => {
      throw new Error("WORKER_CRASH");
    };
    await expect(runConfirmedInvite(req(K1), ports())).rejects.toThrow(/WORKER_CRASH/);
    expect(inv().status).toBe("staged");
    w.faults.beginSend = false;
    w.db.markFailed = origFail;
    w.advance(TTL + 1);
    expect((await runConfirmedInvite(req(K2), ports())).status).toBe("sent");
    expect(w.mail).toHaveLength(1);
  });

  it("mark_sent DB failure: receipt recorded, access off, admin finishes activation with no second email", async () => {
    w.faults.markSent = true;
    expect(await runConfirmedInvite(req(K1), ports())).toEqual({
      status: "needs_reconciliation",
      code: "activation_failed",
    });
    expect(anyActive()).toBe(false);
    expect(inv().provider_message_id).toMatch(/^msg-/);
    w.faults.markSent = false;
    expect(await w.db.finish("inv")).toBe("sent");
    expect(anyActive()).toBe(true);
    expect(w.mail).toHaveLength(1);
  });

  it("mark_sent AND mark_failed DB failure: stays 'sending', expiry turns it into review", async () => {
    w.faults.markSent = true;
    w.faults.markFailed = true;
    expect((await runConfirmedInvite(req(K1), ports())).status).toBe("needs_reconciliation");
    expect(inv().status).toBe("sending");
    expect(anyActive()).toBe(false);
    w.faults.markSent = false;
    w.faults.markFailed = false;
    w.advance(TTL + 1);
    expect((await runConfirmedInvite(req(K2), ports())).status).toBe("needs_reconciliation");
    expect(anyActive()).toBe(false);
    expect(w.mail).toHaveLength(1);
  });

  it("definite rejection after send began is a plain retry with a new key", async () => {
    w.mailPort.mode = "definite";
    expect(await runConfirmedInvite(req(K1), ports())).toEqual({
      status: "failed",
      code: "send_failed",
    });
    expect(anyActive()).toBe(false);
    const k1 = inv().resend_key;
    w.mailPort.mode = "ok";
    expect((await runConfirmedInvite(req(K2), ports())).status).toBe("sent");
    expect(inv().resend_key).not.toBe(k1);
    expect(w.mail).toHaveLength(1);
  });

  it("unknown outcome before any delivery still requires review", async () => {
    w.mailPort.mode = "unknown_before";
    expect((await runConfirmedInvite(req(K1), ports())).status).toBe("needs_reconciliation");
    expect(w.mail).toHaveLength(0);
    expect(anyActive()).toBe(false);
  });

  it("rejects an existing privileged account without altering it", async () => {
    w.users.set("op", { email: "pat@example.test" });
    w.roles.set("op", new Set(["ops_logistics"]));
    expect(await runConfirmedInvite(req(), ports())).toEqual({
      status: "failed",
      code: "existing_account",
    });
    expect([...w.roles.get("op")!]).toEqual(["ops_logistics"]);
    expect(w.mail).toHaveLength(0);
    expect(w.mapping.size).toBe(0);
  });

  it("rejects a pre-existing plain login and a mismatched returned user", async () => {
    w.users.set("old", { email: "pat@example.test" });
    w.roles.set("old", new Set(["ops_orders"]));
    expect(await runConfirmedInvite(req(), ports())).toEqual({
      status: "failed",
      code: "existing_account",
    });
    expect([...w.roles.get("old")!]).toEqual(["ops_orders"]);
    const w2 = world();
    w2.auth.next = () => ({ userId: "foreign", email: "other@example.test" });
    expect(
      await runConfirmedInvite(req(), { db: w2.db, auth: w2.auth, mail: w2.mailPort }),
    ).toEqual({ status: "failed", code: "user_mismatch" });
    expect(w2.mail).toHaveLength(0);
  });
});
