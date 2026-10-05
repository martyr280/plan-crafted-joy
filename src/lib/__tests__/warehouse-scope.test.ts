import { describe, it, expect } from "vitest";
import {
  resolveBranchScope,
  scopedTicketRows,
  branchDriverDto,
  isBranchPath,
} from "../warehouse-scope";
import { loadBranchReport, weekWindow, type BranchReadPort } from "../branch-report";
import type { ReconciledDriver } from "../warehouse-scope";

describe("warehouse scope", () => {
  it("requires exactly one active canonical warehouse and no mixed roles", () => {
    const ok = [{ user_id: "u", warehouse: "Ocala", active: true }];
    expect(resolveBranchScope("u", ["branch_manager"], ok).warehouse).toBe("Ocala");
    expect(() =>
      resolveBranchScope("u", ["branch_manager"], [{ ...ok[0]!, active: false }]),
    ).toThrow();
    expect(() =>
      resolveBranchScope("u", ["branch_manager"], [{ ...ok[0]!, warehouse: "ocala" }]),
    ).toThrow();
    expect(() =>
      resolveBranchScope(
        "u",
        ["branch_manager"],
        [...ok, { user_id: "u", warehouse: "Dallas", active: true }],
      ),
    ).toThrow();
    expect(() => resolveBranchScope("u", ["branch_manager", "ops_orders"], ok)).toThrow(/Mixed/);
    expect(() => resolveBranchScope("u", ["admin"], ok)).toThrow();
  });
  it("ambiguous P21 codes shared across hubs are excluded", () => {
    const routes = [
      { id: "a", code: "X", hub: "Dallas" },
      { id: "b", code: "X", hub: "Ocala" },
      { id: "c", code: "D1", hub: "Dallas", p21_route_code: "D1, D2" },
    ];
    const rows = [{ route_code: "X" }, { route_code: "d2" }, { route_code: "ZZ" }];
    expect(scopedTicketRows({ userId: "u", warehouse: "Dallas" }, routes, rows)).toEqual([
      { route_code: "d2" },
    ]);
  });
  it("driver DTO drops pay, official notes and audit history", () => {
    // Private fields a reconciled driver may carry; the DTO must drop them.
    const driver: ReconciledDriver & Record<string, unknown> = {
      driverId: "d",
      driverName: "N",
      hub: "Dallas",
      flaggedMinutes: 1,
      automatedMinutes: 2,
      official: { source: "PRIVATE", reason: "PRIVATE" },
      payRate: 30,
      paidHours: 9,
      history: ["PRIVATE"],
      events: [],
    };
    const dto = branchDriverDto(driver);
    expect(JSON.stringify(dto)).not.toMatch(/PRIVATE|payRate|paidHours|history/);
  });
  it("week window and branch paths", () => {
    expect(weekWindow("2026-09-28").weekEnd).toBe("2026-10-02");
    expect(() => weekWindow("2026-09-29")).toThrow();
    expect(isBranchPath("/dispatch")).toBe(true);
    expect(isBranchPath("/settings")).toBe(false);
  });
  it("empty authorized route set never queries business data", async () => {
    const touched: string[] = [];
    const port = new Proxy(
      {},
      {
        get: (_t, k) =>
          k === "routes"
            ? async () => [{ id: "x", code: "X", hub: "Ocala" }]
            : async () => {
                touched.push(String(k));
                return [];
              },
      },
    ) as unknown as BranchReadPort;
    const tc = await loadBranchReport(
      { userId: "u", warehouse: "Dallas" },
      { module: "truck-capacity", weekStart: "2026-09-28" },
      port,
    );
    const dp = await loadBranchReport(
      { userId: "u", warehouse: "Dallas" },
      { module: "dispatch", weekStart: "2026-09-28" },
      port,
    );
    expect(tc.module === "truck-capacity" && tc.runs).toEqual([]);
    expect(dp.module === "dispatch" && dp.tickets).toEqual([]);
    expect(touched).toEqual([]);
  });
});
