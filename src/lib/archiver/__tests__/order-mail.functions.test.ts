import { describe, expect, it, vi } from "vitest";
import {
  createContentRule,
  createInternalRoute,
  humanTeamFor,
  listMail,
  listNeedsReply,
  mailSearchFilter,
  teachSender,
  mailAction,
  requireOperator,
  setNote,
  summarizeShadow,
  updateSettings,
  validateSettingsPatch,
  versionAtLeast,
  type Ports,
} from "../order-mail.server";

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("Network disabled in archiver tests");
  }),
);

type Call = { table: string; op: string; args: unknown[]; filters: unknown[][] };

/** Chainable fake of the service-role client: every builder method returns itself; awaiting resolves `results[table]`. */
function fakeDb(results: Record<string, any> = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: "select", args: [], filters: [] };
    calls.push(call);
    const b: any = new Proxy(
      {},
      {
        get(_t, k: string) {
          if (k === "then") {
            const r = typeof results[table] === "function" ? results[table](call) : results[table];
            return (res: any) => res(r ?? { data: [], error: null, count: 0 });
          }
          return (...args: unknown[]) => {
            if (["insert", "update", "upsert", "delete"].includes(k)) {
              call.op = k;
              call.args = args;
            } else if (k !== "select") call.filters.push([k, ...args]);
            return b;
          };
        },
      },
    );
    return b;
  };
  return {
    db: { from, storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) } },
    calls,
  };
}

const TEAMS = { data: [{ key: "E2G" }, { key: "TEAMTEXASLAMS" }], error: null };
const actor = { id: "u1", name: "tester@ndi" };

function ports(
  over: Partial<Ports> & { db: any },
  settings: Record<string, unknown> = { mode: "shadow" },
  roles = ["admin"],
): Ports {
  return {
    hasRole: async (_u, r) => roles.includes(r),
    getSettings: async () => settings,
    graphConfigured: () => false,
    performAction: vi.fn(async () => ({})),
    runTick: vi.fn(async () => ({})),
    applyImportPlan: vi.fn(async () => ({})),
    randomId: () => "abc123",
    ...over,
  };
}

describe("role gate", () => {
  it("refuses a user without admin or ops_orders", async () => {
    const { db } = fakeDb();
    await expect(requireOperator(ports({ db }, {}, ["sales_rep"]), "u1")).rejects.toThrow(
      "Admin or Orders role required",
    );
  });
  it("lets ops_orders through", async () => {
    const { db } = fakeDb();
    await expect(requireOperator(ports({ db }, {}, ["ops_orders"]), "u1")).resolves.toBeUndefined();
  });
});

describe("shadow mailAction", () => {
  it("records an action and human_team_key and never calls performAction", async () => {
    const { db, calls } = fakeDb({
      archiver_teams: TEAMS,
      archiver_messages: { data: { id: "m1", team_key: "E2G" }, error: null },
    });
    const p = ports({ db });
    const r = await mailAction(p, actor, {
      id: "m1",
      action: "wrong_team",
      toTeam: "TEAMTEXASLAMS",
    });
    expect(r).toEqual({ mode: "shadow", recorded: true });
    expect(p.performAction).not.toHaveBeenCalled();
    const ins = calls.find((c) => c.table === "archiver_actions" && c.op === "insert")!;
    expect((ins.args[0] as any).detail.shadow).toBe(true);
    const upd = calls.find((c) => c.table === "archiver_messages" && c.op === "update")!;
    expect(upd.args[0]).toEqual({ human_team_key: "TEAMTEXASLAMS" });
    expect(upd.filters).toContainEqual(["eq", "id", "m1"]);
    expect(
      calls.some(
        (c) =>
          c.table === "archiver_learned" ||
          c.table === "archiver_filings" ||
          c.table === "p21_bridge_jobs",
      ),
    ).toBe(false);
  });
  it("live only when mode=live AND filing_enabled", async () => {
    const { db } = fakeDb({
      archiver_teams: TEAMS,
      archiver_messages: { data: { id: "m1", team_key: "E2G" }, error: null },
    });
    const p = ports({ db }, { mode: "live", filing_enabled: false });
    expect(((await mailAction(p, actor, { id: "m1", action: "archive" })) as any).mode).toBe(
      "shadow",
    );
    expect(p.performAction).not.toHaveBeenCalled();
  });
  it("maps actions to human_team_key", () => {
    expect(humanTeamFor({ id: "x", action: "archive" })).toBe("IGNORED");
    expect(humanTeamFor({ id: "x", action: "restore", toTeam: "E2G" })).toBe("E2G");
    expect(humanTeamFor({ id: "x", action: "also_file", teams: ["E2G"] })).toBeUndefined();
  });
  it("rejects an unknown team as data", async () => {
    const { db } = fakeDb({ archiver_teams: TEAMS });
    expect(
      await mailAction(ports({ db }), actor, { id: "m1", action: "wrong_team", toTeam: "NOPE" }),
    ).toEqual({ ok: false, errors: ["Unknown team 'NOPE'."] });
  });
});

describe("updateSettings", () => {
  const ctx = { graphConfigured: true, agentVersion: "1.5.0" };
  it("refuses unknown keys", () =>
    expect(validateSettingsPatch({ dashboard_port: 1 }, ctx)).toEqual([
      "Unknown setting 'dashboard_port'.",
    ]));
  it("refuses a bad regex", () =>
    expect(validateSettingsPatch({ ignore_subject_patterns: ["(unclosed"] }, ctx)[0]).toMatch(
      /does not compile/,
    ));
  it("refuses live without Graph", () =>
    expect(validateSettingsPatch({ mode: "live" }, { ...ctx, graphConfigured: false })).toEqual([
      "Live mode needs the Microsoft mail connection configured first.",
    ]));
  it("refuses live with an old or unknown agent", () => {
    expect(validateSettingsPatch({ mode: "live" }, { ...ctx, agentVersion: "1.4.0" })[0]).toMatch(
      /1\.5\.0 or newer/,
    );
    expect(validateSettingsPatch({ mode: "live" }, { ...ctx, agentVersion: null })[0]).toMatch(
      /could not be determined/,
    );
  });
  it("bounds retention_days 7..365", () => {
    expect(validateSettingsPatch({ retention_days: 6 }, ctx)).toHaveLength(1);
    expect(validateSettingsPatch({ retention_days: 365 }, ctx)).toEqual([]);
  });
  it("merges into the existing value and writes nothing on error", async () => {
    const { db, calls } = fakeDb();
    const p = ports({ db }, { mode: "shadow", keep: 1 });
    expect(((await updateSettings(p, actor, { nope: 1 })) as any).ok).toBe(false);
    expect(calls.some((c) => c.op !== "select")).toBe(false);
    await updateSettings(p, actor, { paused: true });
    const up = calls.find((c) => c.table === "app_settings" && c.op === "upsert")!;
    expect((up.args[0] as any).value).toEqual({ mode: "shadow", keep: 1, paused: true });
  });
  it("compares versions numerically", () => {
    expect(versionAtLeast("1.10.0", "1.5.0")).toBe(true);
    expect(versionAtLeast("1.4.9", "1.5.0")).toBe(false);
  });
});

describe("rules", () => {
  it("returns validation errors as data", async () => {
    const { db, calls } = fakeDb({ archiver_teams: TEAMS });
    const r = await createContentRule(ports({ db }), actor, { phrase: "ab", team: "E2G" });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });
  it("refuses a duplicate phrase among enabled rows only", async () => {
    const { db, calls } = fakeDb({
      archiver_teams: TEAMS,
      archiver_content_rules: { data: [{ id: "7", phrase: "WORTHINGTON" }], error: null },
    });
    expect(
      await createContentRule(ports({ db }), actor, { phrase: "worthington", team: "E2G" }),
    ).toEqual({ ok: false, errors: ["That phrase already exists for this scope."] });
    expect(calls.find((c) => c.table === "archiver_content_rules")!.filters).toContainEqual([
      "eq",
      "enabled",
      true,
    ]);
  });
  it("creates web rules with a web- id and source web", async () => {
    const { db, calls } = fakeDb({ archiver_teams: TEAMS });
    expect(
      await createContentRule(ports({ db }), actor, { phrase: "Worthington", team: "E2G" }),
    ).toEqual({ ok: true, id: "web-abc123" });
    const ins = calls.find((c) => c.table === "archiver_content_rules" && c.op === "insert")!;
    expect(ins.args[0]).toMatchObject({ id: "web-abc123", source: "web", enabled: true });
  });
  it("in shadow mode only admin may edit rules", async () => {
    const { db } = fakeDb({ archiver_teams: TEAMS });
    await expect(
      createInternalRoute(ports({ db }, { mode: "shadow" }, ["ops_orders"]), actor, {
        address: "a@ndiof.com",
        team: "E2G",
      }),
    ).rejects.toThrow("Admin role required");
  });
});

describe("setNote", () => {
  it("upserts on ledger_key and preserves needs_reply when omitted", async () => {
    const { db, calls } = fakeDb({
      archiver_messages: { data: { id: "m1", ledger_key: "mid:<a@x>" }, error: null },
    });
    await setNote(ports({ db }), actor, { id: "m1", text: "call back" });
    const up = calls.find((c) => c.table === "archiver_notes")!;
    expect(up.op).toBe("upsert");
    expect(up.args[1]).toEqual({ onConflict: "ledger_key" });
    expect(up.args[0]).not.toHaveProperty("needs_reply");
    await setNote(ports({ db }), actor, { id: "m1", text: "x", needs_reply: true });
    expect((calls.filter((c) => c.table === "archiver_notes")[1].args[0] as any).needs_reply).toBe(
      true,
    );
  });
});

describe("shadow report", () => {
  it("counts agreement and human-corrected accuracy", () => {
    const r = summarizeShadow([
      { id: "1", team_key: "A", desktop_team_key: "A", human_team_key: null },
      { id: "2", team_key: "A", desktop_team_key: "B", human_team_key: "A" },
      { id: "3", team_key: "C", desktop_team_key: "B", human_team_key: "B" },
      { id: "4", team_key: "C", desktop_team_key: null, human_team_key: "C" },
    ]);
    expect([r.compared, r.agreed, r.disagreed]).toEqual([3, 1, 2]);
    expect(r.humanCorrected).toEqual({ total: 3, webRight: 2, desktopRight: 1, desktopOnlyRight: 1 });
  });
  it("both engines right does not count as desktop-only right", () => {
    const r = summarizeShadow([{ id: "1", team_key: "A", desktop_team_key: "A", human_team_key: "A" }]);
    expect(r.humanCorrected.desktopRight).toBe(1);
    expect(r.humanCorrected.desktopOnlyRight).toBe(0);
  });
  it("desktop right and web wrong counts as desktop-only right", () => {
    const r = summarizeShadow([{ id: "1", team_key: "B", desktop_team_key: "A", human_team_key: "A" }]);
    expect(r.humanCorrected.desktopOnlyRight).toBe(1);
  });
});

describe("user text never shapes a PostgREST filter", () => {
  const nasty = "a,b)@x.com),and(bucket.eq.domain";
  it("teachSender uses two plain .eq() reads and no .or()", async () => {
    const { db, calls } = fakeDb({ archiver_teams: TEAMS });
    await teachSender(
      ports({ db }, { mode: "live", filing_enabled: true }),
      actor,
      { address: "Joe,Smith)@Acme.com", team: "E2G" },
    );
    const learned = calls.filter((c) => c.table === "archiver_learned" && c.op === "select");
    expect(learned).toHaveLength(2);
    for (const c of learned) expect(c.filters.some((f) => f[0] === "or")).toBe(false);
    expect(learned[0].filters).toContainEqual(["eq", "key", "joe,smith)@acme.com"]);
    expect(learned[1].filters).toContainEqual(["eq", "key", "acme.com"]);
  });
  it("listMail search strips , ( ) before the .or() string", async () => {
    expect(mailSearchFilter(nasty)).toBe(
      "subject.ilike.%a b @x.com  and bucket.eq.domain%,sender_address.ilike.%a b @x.com  and bucket.eq.domain%",
    );
    expect(mailSearchFilter("  ")).toBeNull();
    const { db, calls } = fakeDb();
    await listMail(ports({ db }), { q: "x,y)", page: 0, pageSize: 50 });
    const or = calls.find((c) => c.table === "archiver_messages")!.filters.find((f) => f[0] === "or")!;
    expect(String(or[1])).not.toMatch(/[()]|y\)/);
    expect(String(or[1]).split(",")).toHaveLength(2);
  });
});

describe("listNeedsReply", () => {
  it("reads only needs_reply=true and done=false notes", async () => {
    const { db, calls } = fakeDb({ archiver_notes: { data: [{ ledger_key: "k" }], error: null } });
    const rows = await listNeedsReply(ports({ db }));
    expect(rows).toEqual([{ ledger_key: "k" }]);
    const c = calls.find((x) => x.table === "archiver_notes")!;
    expect(c.op).toBe("select");
    expect(c.filters).toContainEqual(["eq", "needs_reply", true]);
    expect(c.filters).toContainEqual(["eq", "done", false]);
  });
});
