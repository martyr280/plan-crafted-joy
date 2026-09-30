import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
import { planSends, verifyRepRows, attachmentName, repEmailContent, firstName } from "../sales-report-email";
import { executeSends, buildVerifiedAttachment } from "../sales-report-email.server";

// Kill-switch: no network from this file.
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error("network disabled in tests"); }) as any; });
afterAll(() => { globalThis.fetch = realFetch; });

const row = (rep: string, i: number) => ({
  id: `${rep}-${i}`, rep_code: rep, rep_name: rep === "A" ? "Alice Smith" : "Bob Jones", cust_code: `C${i}`,
  price_level: null, bg: null, customer_name: `Cust ${i}`, city: null, state: null, total_value: 0,
  y2022: 0, y2023: 0, y2024: 0, y2025: 0, y_current: 100, ann_current: 0, pct: 0, month_sales: 10, month_profit: 1,
  keep_lvl_code: null, keep_lvl_threshold: null, keep_lvl_shortfall: null,
});
const DB: Record<string, any[]> = { A: [row("A", 1), row("A", 2), row("A", 3)], B: [row("B", 1), row("B", 2)] };
const reps = [
  { rep_code: "A", rep_name: "Alice Smith", rows: 3, status: "ok" },
  { rep_code: "B", rep_name: "Bob Jones", rows: 2, status: "ok" },
  { rep_code: "C", rep_name: "Carl", rows: 4, status: "ok" },
  { rep_code: "D", rep_name: "Dee", rows: 1, status: "ok" },
  { rep_code: "E", rep_name: "Empty", rows: 0, status: "no_activity" },
];
const contacts = [
  { rep_code: "A", rep_name: "Alice Smith", email: "alice@ndi.test", cc_emails: [], send_enabled: true },
  { rep_code: "B", rep_name: "Bob Jones", email: "bob@ndi.test", cc_emails: ["mgr@ndi.test"], send_enabled: true },
  { rep_code: "C", rep_name: "Carl", email: null, cc_emails: [], send_enabled: true },
  { rep_code: "D", rep_name: "Dee", email: "dee@ndi.test", cc_emails: [], send_enabled: false },
];
const ctx = (prior: any[] = []) => ({ run: { id: "run1", run_at: "", year: 2026, month: 8, status: "done" }, reps, contacts, prior });
const base = { reps, contacts, year: 2026, month: 8, sendAgain: false, testMode: false, sessionEmail: "me@ndi.test" };

function harness(fetchRows = async (_r: string, code: string) => DB[code] ?? []) {
  const sender = vi.fn(async () => ({ id: "msg" }));
  const logs: any[] = [];
  return { sender, logs, fetchRows, log: async (r: any) => { logs.push(r); } };
}

describe("sales report emails", () => {
  it("file name is NDI_Sales_<RepCode>_<YYYY-MM>.xlsx", () => {
    expect(attachmentName("5333", 2026, 8)).toBe("NDI_Sales_5333_2026-08.xlsx");
  });

  it("skip reasons: no email, send off, no rows, no contact", () => {
    const p = planSends({ ...base, selected: ["A", "B", "C", "D", "E", "Z"], prior: [] });
    expect(p.send.map((s) => s.rep_code)).toEqual(["A", "B"]);
    expect(Object.fromEntries(p.skipped.map((s) => [s.rep_code, s.reason]))).toEqual({ C: "no_email", D: "send_off", E: "no_rows", Z: "no_rows" });
    expect(p.send[1]).toMatchObject({ to: "bob@ndi.test", cc: ["mgr@ndi.test"] });
  });

  it("test mode: every recipient is the session user, no CC", () => {
    const p = planSends({ ...base, selected: ["A", "B", "C", "D"], prior: [], testMode: true });
    expect(p.send.map((s) => [s.to, s.cc.length])).toEqual([["me@ndi.test", 0], ["me@ndi.test", 0], ["me@ndi.test", 0], ["me@ndi.test", 0]]);
    expect(() => planSends({ ...base, selected: ["A"], prior: [], testMode: true, sessionEmail: null })).toThrow();
  });

  it("Send again guard: a real prior send blocks unless ticked; test sends don't count", () => {
    const prior = [{ rep_code: "A", status: "sent", test_mode: false, created_at: "2026-09-30T00:00:00Z", to_email: "alice@ndi.test" },
                   { rep_code: "B", status: "sent", test_mode: true, created_at: "2026-09-30T00:00:00Z", to_email: "me@ndi.test" }];
    const p1 = planSends({ ...base, selected: ["A", "B"], prior });
    expect(p1.skipped).toEqual([{ rep_code: "A", rep_name: "Alice Smith", reason: "already_sent" }]);
    expect(planSends({ ...base, selected: ["A", "B"], prior, sendAgain: true }).send).toHaveLength(2);
  });

  it("attachment builder only includes the recipient's rows", async () => {
    const att = await buildVerifiedAttachment(async (_r, c) => DB[c]!, "run1", "A", 2026, 8, 3);
    expect(att.ok).toBe(true);
    if (att.ok) { expect(att.rows.every((r) => r.rep_code === "A")).toBe(true); expect(att.filename).toBe("NDI_Sales_A_2026-08.xlsx"); }
    expect(verifyRepRows([...DB.A!, DB.B![0]!], "A", 4)).toMatch(/another rep \(B\)/);
    expect(verifyRepRows(DB.A!, "A", 2)).toMatch(/does not match preview/);
  });

  it("mismatch → failed, not sent; other reps still sent; every attempt logged", async () => {
    const h = harness(async (_r, code) => (code === "A" ? [...DB.A!, DB.B![0]!] : DB[code]!));
    const res = await executeSends({ ctx: ctx(), selected: ["A", "B", "C"], expectedRows: { A: 3, B: 2 }, sendAgain: false, testMode: false,
      sessionEmail: null, userId: "u1", fetchRows: h.fetchRows, sender: h.sender, log: h.log });
    expect(res.map((r) => [r.rep_code, r.status])).toEqual([["C", "skipped"], ["A", "failed"], ["B", "sent"]]);
    expect(h.sender).toHaveBeenCalledTimes(1);
    const call = (h.sender.mock.calls[0] as any)[0];
    expect(call.to).toBe("bob@ndi.test");
    expect(call.subject).not.toMatch(/Alice/);
    expect(call.html).not.toMatch(/Alice/);
    expect(h.logs.map((l) => l.status)).toEqual(["skipped", "failed", "sent"]);
  });

  it("preview count differing from the run → failed and no send", async () => {
    const h = harness();
    const res = await executeSends({ ctx: ctx(), selected: ["A"], expectedRows: { A: 99 }, sendAgain: false, testMode: false,
      sessionEmail: null, userId: "u1", fetchRows: h.fetchRows, sender: h.sender, log: h.log });
    expect(res[0]!.status).toBe("failed");
    expect(h.sender).not.toHaveBeenCalled();
  });

  it("test mode sends go to the session user with [TEST] and test_mode=true", async () => {
    const h = harness();
    await executeSends({ ctx: ctx(), selected: ["A"], expectedRows: { A: 3 }, sendAgain: false, testMode: true,
      sessionEmail: "me@ndi.test", userId: "u1", fetchRows: h.fetchRows, sender: h.sender, log: h.log });
    const call = (h.sender.mock.calls[0] as any)[0];
    expect(call.to).toBe("me@ndi.test");
    expect(call.subject.startsWith("[TEST] ")).toBe(true);
    expect(h.logs[0]).toMatchObject({ test_mode: true, status: "sent", to_email: "me@ndi.test" });
  });

  it("body: first name + own figures", () => {
    const c = repEmailContent("Alice Smith", 2026, 8, DB.A as any, false);
    expect(c.text).toContain("Hi Alice, attached is your August 2026 sales report from NDI.");
    expect(c.text).toContain("YTD sales: $300");
    expect(firstName("HOUSE ACCOUNT NDI")).toBe("there");
  });
});
