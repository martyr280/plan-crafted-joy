// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";

const ports = vi.hoisted(() => ({ roles: [] as string[], listCalls: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ roles: ports.roles, hasAnyRole: (rs: string[]) => rs.some((r) => ports.roles.includes(r)) }),
}));
vi.mock("@/hooks/useDriverTime", () => ({
  useDriverPayRates: (enabled: boolean) => {
    ports.listCalls(enabled);
    return {
      isLoading: false, isError: false,
      data: {
        drivers: [{ id: "d1", name: "Synthetic Driver", source: "roster" }],
        rates: [{ id: "r1", driver_id: "d1", hourly_rate: 20, effective_date: "2026-01-05", updated_at: "x" }],
        rosterError: null,
      },
    };
  },
  useAddDriverPayRate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDriverPayRate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { DriverRatesPanel } from "../DriverRatesPanel";

afterEach(() => { cleanup(); ports.listCalls.mockClear(); });

describe("DriverRatesPanel visibility", () => {
  for (const roles of [[], ["ops_logistics"], ["ops_logistics_admin"], ["branch_manager"], ["sales_rep"]]) {
    it(`hidden and loads no rates for ${roles.join(",") || "no role"}`, () => {
      ports.roles = roles;
      const { container } = render(<DriverRatesPanel />);
      expect(container.innerHTML).toBe("");
      expect(screen.queryByText(/\$20\.00/)).toBeNull();
      expect(ports.listCalls).not.toHaveBeenCalled();
    });
  }
  it("admin sees drivers with current rate and effective date", () => {
    ports.roles = ["admin"];
    render(<DriverRatesPanel />);
    expect(screen.getByTestId("driver-rates-panel")).toBeTruthy();
    expect(screen.getByText("Synthetic Driver")).toBeTruthy();
    expect(screen.getByText("$20.00/hr")).toBeTruthy();
    expect(screen.getByText(/since 2026-01-05/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});
