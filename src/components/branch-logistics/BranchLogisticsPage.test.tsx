import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const state = vi.hoisted(() => ({ data: null as any, error: null as any }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.data, isPending: false, isError: !!state.error, error: state.error }) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => () => { throw Error("No server request in render test"); } }));
vi.mock("@/lib/branch-logistics.functions", () => ({ getBranchLogisticsReport: () => { throw Error("No endpoint call"); } }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "synthetic-manager" } }) }));
import { BranchLogisticsPage } from "./BranchLogisticsPage";

describe("read-only branch report presentation", () => {
  it("driver totals without edit, payroll, sweep or history controls", () => {
    state.error = null;
    state.data = { warehouse: "Birmingham", thresholdMinutes: 90, totals: { flaggedMinutes: 180 }, drivers: [{ driverId: "s", driverName: "Synthetic Driver", flaggedMinutes: 180, hasOfficial: false, events: [] }] };
    const html = renderToStaticMarkup(<BranchLogisticsPage module="driver-time" />);
    expect(html).toContain("Birmingham"); expect(html).toContain("3:00");
    expect(html).not.toMatch(/Paycom|Save|Run sweep|Correction history|hourly rate/);
  });
  it("missing measurements show Unknown and stale cache is flagged; no action controls", () => {
    state.error = null;
    state.data = { warehouse: "Dallas", routes: [], runs: [], tickets: [{ pick_ticket_no: "SYN", route_code: "D", est_pallets: null, est_cube_ft: null }], stops: [], pulledAt: "2000-01-01T00:00:00Z", board: { upcoming: [], stale: [] } };
    const html = renderToStaticMarkup(<BranchLogisticsPage module="dispatch" />);
    expect(html).toContain("Unknown"); expect(html).toContain("older than 36 hours");
    expect(html).not.toMatch(/Approve|Push|Refresh P21|Create address|Export/);
  });
  it("access failure is visible, not an empty warehouse", () => {
    state.data = null; state.error = new Error("Warehouse access is not configured");
    const html = renderToStaticMarkup(<BranchLogisticsPage module="truck-capacity" />);
    expect(html).toContain('role="alert"'); expect(html).toContain("Warehouse access is not configured");
  });
});
