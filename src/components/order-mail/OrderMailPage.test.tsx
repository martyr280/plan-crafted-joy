import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("Network disabled in Order Mail render tests");
  }),
);

const state = vi.hoisted(() => ({ roles: [] as string[], overview: null as any }));
const idle = { data: undefined, isError: false, error: null };
const mut = { mutate: () => {}, mutateAsync: async () => ({}), isPending: false, data: undefined };
vi.mock("@/hooks/useOrderMail", () => ({
  useOmOverview: () => ({ data: state.overview, isError: false, error: null }),
  useOmTeams: () => ({ data: [] }),
  useOmMail: () => ({ data: { rows: [], total: 0, page: 0, pageSize: 50 }, isError: false }),
  useOmMailDetail: () => idle,
  useOmNeedsReply: () => ({ data: [], isError: false }),
  useOmRules: () => ({ data: { contentRules: [], internalRoutes: [], multiRoutes: [] } }),
  useOmLearned: () => ({ data: [] }),
  useOmShadow: () => ({ data: undefined }),
  useOmSettings: () => idle,
  ...Object.fromEntries(
    ["useOmMailAction", "useOmSetNote", "useOmTeach", "useOmCreateContent", "useOmCreateInternal", "useOmCreateMulti", "useOmDisableContent", "useOmDisableInternal", "useOmDisableMulti", "useOmPreview", "useOmForget", "useOmUpdateSettings", "useOmUpdateMailbox", "useOmSweepNow", "useOmProbe", "useOmImport"].map((k) => [k, () => mut]),
  ),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    hasRole: (r: string) => state.roles.includes(r),
    hasAnyRole: (rs: string[]) => rs.some((r) => state.roles.includes(r)),
  }),
}));

import { OrderMailPage, SHADOW_TEXT, gateMet } from "./OrderMailPage";
import { EMPTY_MAIL } from "./shared";

const overview = {
  settings: { mode: "shadow", paused: false, effective_mode: "shadow", graph_configured: false },
  mailboxes: [],
  today: { total: 0, byStatus: {}, byTeam: {} },
  unrouted: 0,
  needsReply: 0,
  runs: [],
  openFilings: {},
  bridge: { agents: [{ name: "NDI-P21", version: "1.4.0", last_seen_at: null }] },
  probeJob: { status: "pending" },
};
const render = () => renderToStaticMarkup(<OrderMailPage />);
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("Order Mail page", () => {
  it("shows the shadow banner, connection and agent warnings", () => {
    state.roles = ["admin"];
    state.overview = overview;
    const html = decode(render());
    expect(html).toContain(SHADOW_TEXT);
    expect(html).toContain("SHADOW");
    expect(html).toContain("Not connected to the mailbox yet.");
    expect(html).toContain("File agent needs update to 1.5.0 (installed: 1.4.0)");
  });
  it("shows the empty-mailbox message instead of a blank table", () => {
    state.roles = ["admin"];
    state.overview = overview;
    expect(decode(render())).toContain(EMPTY_MAIL);
  });
  it("shows the Settings tab and admin buttons to admins only", () => {
    state.overview = overview;
    state.roles = ["admin"];
    const admin = render();
    expect(admin).toMatch(/>Settings</);
    expect(admin).toContain("Sweep now");
    state.roles = ["ops_orders"];
    const ops = render();
    expect(ops).not.toMatch(/>Settings</);
    expect(ops).not.toContain("Sweep now");
    expect(ops).not.toContain("Check archive folder");
    expect(decode(ops)).toContain(SHADOW_TEXT);
  });
  it("refuses users without admin or ops_orders", () => {
    state.roles = ["sales_rep"];
    state.overview = overview;
    const html = render();
    expect(html).toContain("You need the Admin or Orders role");
    expect(html).not.toContain("Mail Activity");
  });
  it("go-live gate: 98% over 500+ and zero desktop-right corrections", () => {
    expect(gateMet({ compared: 500, agreed: 490, humanCorrected: { desktopRight: 0 } })).toBe(true);
    expect(gateMet({ compared: 499, agreed: 499, humanCorrected: { desktopRight: 0 } })).toBe(false);
    expect(gateMet({ compared: 500, agreed: 489, humanCorrected: { desktopRight: 0 } })).toBe(false);
    expect(gateMet({ compared: 1000, agreed: 1000, humanCorrected: { desktopRight: 1 } })).toBe(false);
  });
});
