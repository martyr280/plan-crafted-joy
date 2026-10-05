// Synthetic-only: fake auth, mail and database ports. No network, no real accounts.
import { describe, it, expect, beforeEach } from "vitest";
import { runConfirmedInvite, normalizeEmail, type InviteDbPort, type InviteAuthPort, type InviteMailPort } from "../branch-invite";

type Inv = { id: string; email: string; warehouse: string; status: string; user_id: string | null; request_key: string | null; resend_key: string | null; last_error: string | null; display_name: string | null };

const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";

function world() {
  const invites = new Map<string, Inv>();
  const roles = new Map<string, Set<string>>();
  const mapping = new Map<string, { warehouse: string; active: boolean; invite: string }>();
  const users = new Map<string, { email: string; preexisting: boolean }>();
  const mail: { to: string; key: string; link: string }[] = [];
  const log: string[] = [];
  let seq = 0;
  invites.set("inv", { id: "inv", email: "pat@example.test", warehouse: "Dallas", status: "draft", user_id: null, request_key: null, resend_key: null, last_error: null, display_name: "Pat" });

  // Mirrors bm_claim / bm_stage / bm_mark_sent / bm_mark_failed semantics.
  const db: InviteDbPort = {
    async claim(r) {
      const i = invites.get(r.inviteId)!;
      if (i.email !== r.email || i.warehouse !== r.warehouse) throw new Error("request_mismatch");
      if (i.status === "sent") return { outcome: "already_sent" };
      if (["cancelled", "revoked"].includes(i.status)) throw new Error("not_invitable");
      if (["claimed", "staged"].includes(i.status)) { if (i.request_key === r.requestKey) return { outcome: "in_progress" }; throw new Error("in_flight"); }
      i.resend_key = i.last_error === "unknown_outcome" && i.resend_key ? i.resend_key : `rk-${++seq}`;
      Object.assign(i, { status: "claimed", request_key: r.requestKey, last_error: null });
      return { outcome: "claimed", resend_key: i.resend_key, user_id: i.user_id, display_name: i.display_name };
    },
    async stage(id, key, userId) {
      const i = invites.get(id)!;
      if (i.status !== "claimed" || i.request_key !== key) throw new Error("stale_claim");
      const u = users.get(userId);
      if (!u || u.email !== i.email || (i.user_id && i.user_id !== userId)) throw new Error("user_mismatch");
      const rs = roles.get(userId) ?? new Set();
      if ([...rs].some((x) => x !== "ops_orders" && x !== "branch_manager")) throw new Error("existing_privileged_account");
      if (!i.user_id && u.preexisting) throw new Error("existing_account");
      roles.set(userId, new Set(["branch_manager"]));
      mapping.set(userId, { warehouse: i.warehouse, active: false, invite: id });
      Object.assign(i, { status: "staged", user_id: userId });
    },
    async markSent(id, key) {
      const i = invites.get(id)!;
      if (i.status !== "staged" || i.request_key !== key) throw new Error("stale_claim");
      mapping.get(i.user_id!)!.active = true;
      i.status = "sent";
    },
    async markFailed(id, key, code) {
      const i = invites.get(id)!;
      if (!["claimed", "staged"].includes(i.status) || i.request_key !== key) return;
      for (const m of mapping.values()) if (m.invite === id) m.active = false;
      Object.assign(i, { status: "failed", last_error: code });
    },
  };
  const auth: InviteAuthPort & { calls: number; next?: (email: string) => { userId: string; email: string } } = {
    calls: 0,
    async findUserIdByEmail(email) { for (const [id, u] of users) if (u.email === email) return id; return null; },
    async generateLink(email, _n, existing) {
      auth.calls++;
      const o = auth.next?.(email);
      const id = existing ?? o?.userId ?? `user-${++seq}`;
      if (!users.has(id)) { users.set(id, { email: o?.email ?? email, preexisting: false }); roles.set(id, new Set(["ops_orders"])); }
      return { userId: id, email: o?.email ?? email, actionLink: `https://synthetic.invalid/verify?token=SECRET-${seq}` };
    },
  };
  const delivered = new Set<string>();
  const mailPort: InviteMailPort & { mode: "ok" | "unknown" | "definite" | "unknown_after_accept" } = {
    mode: "ok",
    async send(to, link, key) {
      log.push(`send ${to}`);
      if (mailPort.mode === "definite") throw Object.assign(new Error("x"), { kind: "definite" });
      if (mailPort.mode === "unknown") throw Object.assign(new Error("x"), { kind: "unknown" });
      // Provider idempotency: same key never delivers twice.
      if (!delivered.has(key)) { delivered.add(key); mail.push({ to, key, link }); }
      if (mailPort.mode === "unknown_after_accept") throw Object.assign(new Error("x"), { kind: "unknown" });
    },
  };
  return { invites, roles, mapping, users, mail, db, auth, mailPort };
}

const req = (key = K1, extra: any = {}) => ({ actorId: "admin", inviteId: "inv", requestKey: key, email: " Pat@Example.TEST ", warehouse: "Dallas", ...extra });

describe("confirmed warehouse-manager invite (synthetic ports)", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world(); });
  const ports = () => ({ db: w.db, auth: w.auth, mail: w.mailPort });

  it("normalizes email and rejects invalid input", () => {
    expect(normalizeEmail("  A.B@Ex.com ")).toBe("a.b@ex.com");
    expect(() => normalizeEmail("nope")).toThrow();
  });

  it("happy path: stages inactive, sends once, then activates; never returns the link", async () => {
    const out = await runConfirmedInvite(req(), ports());
    expect(out).toEqual({ status: "sent", duplicate: false });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|token/);
    expect(w.mail).toHaveLength(1);
    const [uid] = [...w.mapping.keys()];
    expect(w.mapping.get(uid!)).toMatchObject({ warehouse: "Dallas", active: true });
    expect([...w.roles.get(uid!)!]).toEqual(["branch_manager"]);
  });

  it("repeated submit of the same request after success sends no second email", async () => {
    await runConfirmedInvite(req(), ports());
    const again = await runConfirmedInvite(req(), ports());
    expect(again).toEqual({ status: "sent", duplicate: true });
    expect(w.mail).toHaveLength(1);
    expect(w.auth.calls).toBe(1);
  });

  it("concurrent submits: one sends, the other is in-progress or rejected; one email", async () => {
    const results = await Promise.allSettled([runConfirmedInvite(req(K1), ports()), runConfirmedInvite(req(K1), ports()), runConfirmedInvite(req(K2), ports())]);
    expect(w.mail).toHaveLength(1);
    expect(w.auth.calls).toBe(1);
    const ok = results.filter((r) => r.status === "fulfilled").map((r: any) => r.value.status);
    expect(ok.filter((s) => s === "sent")).toHaveLength(1);
  });

  it("cancellation before dispatch has zero effects", async () => {
    w.invites.get("inv")!.status = "cancelled";
    await expect(runConfirmedInvite(req(), ports())).rejects.toThrow(/not_invitable/);
    expect(w.auth.calls).toBe(0);
    expect(w.mail).toHaveLength(0);
    expect(w.users.size).toBe(0);
    expect(w.mapping.size).toBe(0);
  });

  it("warehouse or email cannot change under the same request", async () => {
    await expect(runConfirmedInvite(req(K1, { warehouse: "Ocala" }), ports())).rejects.toThrow(/request_mismatch/);
    expect(w.auth.calls).toBe(0);
  });

  it("unknown provider outcome fails closed and the retry reuses the provider key (no duplicate)", async () => {
    w.mailPort.mode = "unknown_after_accept";
    const first = await runConfirmedInvite(req(K1), ports());
    expect(first).toEqual({ status: "failed", code: "unknown_outcome" });
    const uid = [...w.mapping.keys()][0]!;
    expect(w.mapping.get(uid)!.active).toBe(false);
    w.mailPort.mode = "ok";
    const retry = await runConfirmedInvite(req(K2), ports());
    expect(retry.status).toBe("sent");
    expect(w.mail).toHaveLength(1);
    expect(w.mapping.get(uid)!.active).toBe(true);
    expect(w.users.size).toBe(1); // same account reused, no orphan
  });

  it("definite send failure leaves no usable access and is retryable with a new key", async () => {
    w.mailPort.mode = "definite";
    expect(await runConfirmedInvite(req(K1), ports())).toEqual({ status: "failed", code: "send_failed" });
    const uid = [...w.mapping.keys()][0]!;
    expect(w.mapping.get(uid)!.active).toBe(false);
    const k1 = w.invites.get("inv")!.resend_key;
    w.mailPort.mode = "ok";
    expect((await runConfirmedInvite(req(K2), ports())).status).toBe("sent");
    expect(w.invites.get("inv")!.resend_key).not.toBe(k1);
  });

  it("rejects an existing privileged account without altering it", async () => {
    w.users.set("op", { email: "pat@example.test", preexisting: true });
    w.roles.set("op", new Set(["ops_logistics"]));
    const out = await runConfirmedInvite(req(), ports());
    expect(out).toEqual({ status: "failed", code: "existing_privileged_account" });
    expect([...w.roles.get("op")!]).toEqual(["ops_logistics"]);
    expect(w.mail).toHaveLength(0);
    expect(w.mapping.size).toBe(0);
  });

  it("rejects a pre-existing plain login and a mismatched returned user", async () => {
    w.users.set("old", { email: "pat@example.test", preexisting: true });
    w.roles.set("old", new Set(["ops_orders"]));
    expect(await runConfirmedInvite(req(), ports())).toEqual({ status: "failed", code: "existing_account" });
    const w2 = world();
    w2.auth.next = () => ({ userId: "foreign", email: "other@example.test" });
    expect(await runConfirmedInvite(req(), { db: w2.db, auth: w2.auth, mail: w2.mailPort })).toEqual({ status: "failed", code: "user_mismatch" });
    expect(w2.mapping.size).toBe(0);
    expect(w2.mail).toHaveLength(0);
  });
});
