import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canManageDriverPay, driverTimeGates } from "../access";
import {
  priceDriverWeek,
  duplicatePayRateMessage,
  payRateWriteError,
  STALE_PAY_RATE_MESSAGE,
  type RatedCostInput,
} from "../rates";

const ROLES = [
  ["global admin", ["admin"], true],
  ["logistics admin", ["ops_logistics_admin"], true],
  ["logistics admin plus orders", ["ops_logistics_admin", "ops_logistics", "ops_orders"], true],
  ["plain logistics", ["ops_logistics"], false],
  ["orders only", ["ops_orders"], false],
  ["branch manager", ["branch_manager"], false],
  ["combined branch and admin", ["branch_manager", "admin"], false],
  ["combined branch and logistics admin", ["branch_manager", "ops_logistics_admin"], false],
  ["unauthenticated", [], false],
] as const;

describe("driver pay role matrix", () => {
  for (const [label, roles, allowed] of ROLES) {
    it(`${label} ${allowed ? "can" : "cannot"} manage driver pay`, () => {
      expect(canManageDriverPay(roles)).toBe(allowed);
      expect(canManageDriverPay(roles === undefined ? null : [...roles])).toBe(allowed);
    });
  }
  it("null roles are denied", () => {
    expect(canManageDriverPay(null)).toBe(false);
    expect(canManageDriverPay(undefined)).toBe(false);
  });
  it("logistics admin is not a global admin and does not open diagnostics", () => {
    const gates = driverTimeGates(["ops_logistics_admin", "ops_logistics", "ops_orders"]);
    expect(gates.canManageDriverPay).toBe(true);
    expect(gates.isAdmin).toBe(false);
    expect(gates.canOpenDiagnostics).toBe(false);
    expect(gates.canViewModule).toBe(true);
  });
  it("global admin still opens diagnostics", () => {
    const gates = driverTimeGates(["admin"]);
    expect(gates.isAdmin).toBe(true);
    expect(gates.canOpenDiagnostics).toBe(true);
    expect(gates.canManageDriverPay).toBe(true);
  });
  it("combined branch+admin keeps diagnostics flag as the existing admin check and denies pay", () => {
    const gates = driverTimeGates(["admin", "branch_manager"]);
    expect(gates.canManageDriverPay).toBe(false);
    expect(gates.isAdmin).toBe(true);
    expect(gates.canOpenDiagnostics).toBe(true);
  });
  it("plain logistics can open the module and cannot see pay", () => {
    const gates = driverTimeGates(["ops_logistics"]);
    expect(gates.canViewModule).toBe(true);
    expect(gates.canManageDriverPay).toBe(false);
    expect(gates.canOpenDiagnostics).toBe(false);
  });
});

const priced: RatedCostInput = {
  driverId: "d1",
  driverName: "Synthetic Driver",
  samsaraWeekHours: 0,
  paycomHours: 40,
  flaggedHours: 2,
  byDay: { "2026-11-09": 120 },
  unsplitMinutes: 0,
  weekStart: "2026-11-09",
  weekEnd: "2026-11-13",
  rates: [
    {
      id: "r1",
      driver_id: "d1",
      driver_name: "Synthetic Driver",
      hourly_rate: 22.5,
      effective_date: "2026-01-01",
    },
    {
      id: "secret",
      driver_id: "d9",
      driver_name: "Other Person",
      hourly_rate: 99,
      effective_date: "2026-01-01",
    },
  ],
};

describe("pay amounts stay off unauthorized cost objects", () => {
  it("a denied role gets no rate, no cost, and no other driver's amount", () => {
    const cost = priceDriverWeek(false, priced);
    expect(cost.hourlyRate).toBeNull();
    expect(cost.cost).toBeNull();
    expect(cost.multiplier).toBeNull();
    expect(cost.dailyRates).toEqual([]);
    const dumped = JSON.stringify(cost);
    expect(dumped).not.toMatch(/22\.5|99|Other Person/);
  });
  it("an allowed role is priced from that driver's rate only", () => {
    const cost = priceDriverWeek(true, priced);
    expect(cost.hourlyRate).toBe(22.5);
    expect(cost.cost).toBe(2 * 22.5 * 1.5);
    expect(JSON.stringify(cost)).not.toMatch(/"hourly_rate":99|Other Person/);
  });
});

describe("rate write errors", () => {
  it("duplicate effective date, invalid-looking db error, and stale update", () => {
    expect(payRateWriteError({ code: "23505" }, "2026-11-09").message).toBe(
      duplicatePayRateMessage("2026-11-09"),
    );
    expect(payRateWriteError({ message: "hourly_rate check failed" }, "2026-11-09").message).toBe(
      "hourly_rate check failed",
    );
    expect(STALE_PAY_RATE_MESSAGE).toMatch(/changed since you opened it/);
  });
});

describe("server gates stay narrow", () => {
  const src = readFileSync("src/lib/driver-time.functions.ts", "utf8");
  function body(name: string) {
    const start = src.indexOf(`export const ${name}`);
    const next = src.indexOf("\nexport const ", start + 10);
    return src.slice(start, next === -1 ? undefined : next);
  }
  it("rate handlers use the driver-pay gate", () => {
    for (const name of ["listDriverPayRates", "addDriverPayRate", "updateDriverPayRate"]) {
      expect(body(name)).toContain("requireDriverPay");
      expect(body(name)).not.toContain("requireAdmin");
    }
  });
  it("diagnostics and warehouse-remark editing stay global admin", () => {
    expect(body("getSamsaraDiagnostics")).toContain("requireAdmin");
    expect(body("getSamsaraDiagnostics")).not.toContain("requireDriverPay");
    expect(src).toContain("Only admins can change the per-driver Warehouse-remark setting");
    expect(src).toContain('_role: "admin"');
  });
});
