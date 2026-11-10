// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DriverTimeReport } from "../DriverTimeReport";

const emptyTotals = {
  drivers: 0,
  flaggedMinutes: 0,
  needsReview: 0,
  officialDrivers: 0,
  estimatedCost: 0,
  driversWithoutRate: 0,
};

function kpi(label: string) {
  return screen.getByText(label).parentElement?.textContent ?? "";
}

afterEach(() => cleanup());

describe("DriverTimeReport", () => {
  it("shows loading figures and no zero counts while the week is pending", () => {
    render(<DriverTimeReport isError={false} isLoading hasData={false} onRetry={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading week/);
    expect(screen.getAllByLabelText("Loading")).toHaveLength(4);
    expect(kpi("Drivers in report")).not.toMatch(/0/);
    expect(kpi("Needs review")).not.toMatch(/0/);
    expect(screen.queryByText(/driver\(s\) have official/)).toBeNull();
    expect(screen.getByText(/still loading/)).toBeTruthy();
  });

  it("shows an unavailable report and a retry on the first failure", () => {
    const onRetry = vi.fn();
    render(
      <DriverTimeReport
        isError
        isLoading={false}
        hasData={false}
        errorMessage="timeout"
        onRetry={onRetry}
        totals={{ ...emptyTotals, drivers: 4, needsReview: 2 }}
      />,
    );
    expect(screen.getByText(/Report unavailable: timeout/)).toBeTruthy();
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(4);
    expect(kpi("Needs review")).not.toMatch(/2/);
    expect(kpi("Drivers in report")).not.toMatch(/4/);
    expect(screen.queryByText(/driver\(s\) have official/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps counts unavailable while a failed week is retrying", () => {
    render(
      <DriverTimeReport
        isError
        isLoading={false}
        isFetching
        hasData={false}
        errorMessage="timeout"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Loading week/);
    expect(screen.getAllByLabelText("Loading")).toHaveLength(4);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(kpi("Needs review")).not.toMatch(/0/);
  });

  it("shows zero counts after a successful empty week", () => {
    render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        totals={emptyTotals}
        hubGroups={[]}
      />,
    );
    expect(kpi("Drivers in report")).toMatch(/0/);
    expect(kpi("Needs review")).toMatch(/0/);
    expect(screen.getByText(/0 driver\(s\) have official weekday totals/)).toBeTruthy();
    expect(screen.getByText(/does not prove zero hours/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows an em dash when every computed cost is null, even if both rates are known", () => {
    render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay
        totals={{ ...emptyTotals, drivers: 2, estimatedCost: 0, driversWithoutRate: 0 }}
        drivers={[
          { cost: { cost: null, hourlyRate: 20 } },
          { cost: { cost: null, hourlyRate: 22 } },
        ]}
        hubGroups={[{ hub: "Dallas", drivers: [], flaggedMinutes: 0 }]}
      />,
    );
    expect(kpi("Estimated cost")).toMatch(/—/);
    expect(kpi("Estimated cost")).not.toMatch(/\$0|Partial/);
    expect(screen.getByText(/2 of 2 driver\(s\) have no computed cost/)).toBeTruthy();
    expect(screen.getByText(/0 of 2 drivers priced/)).toBeTruthy();
    expect(screen.queryByText(/no hourly rate on file/)).toBeNull();
  });

  it("labels a mixed week as partial when one computed cost is missing and both rates are known", () => {
    render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay
        totals={{ ...emptyTotals, drivers: 2, estimatedCost: 40, driversWithoutRate: 0 }}
        drivers={[{ cost: { cost: 40, hourlyRate: 20 } }, { cost: { cost: null, hourlyRate: 22 } }]}
        hubGroups={[{ hub: "Dallas", drivers: [], flaggedMinutes: 0 }]}
      />,
    );
    const cost = screen.getByText("Partial: $40 (1 of 2 drivers priced)");
    expect(cost.className).toMatch(/text-warning-text/);
    expect(kpi("Estimated cost")).not.toMatch(/Estimated cost\$40$/);
    expect(screen.getByText(/1 of 2 driver\(s\) have no computed cost/)).toBeTruthy();
    expect(screen.queryByText(/no hourly rate on file/)).toBeNull();
  });

  it("labels a known zero beside an unavailable cost as partial, not a complete $0", () => {
    render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay
        totals={{ ...emptyTotals, drivers: 2, estimatedCost: 0, driversWithoutRate: 0 }}
        drivers={[{ cost: { cost: 0, hourlyRate: 18 } }, { cost: { cost: null, hourlyRate: 18 } }]}
        hubGroups={[{ hub: "Dallas", drivers: [], flaggedMinutes: 0 }]}
      />,
    );
    expect(screen.getByText("Partial: $0 (1 of 2 drivers priced)")).toBeTruthy();
    expect(kpi("Estimated cost")).toMatch(/Partial/);
    expect(screen.getByText(/1 of 2 driver\(s\) have no computed cost/)).toBeTruthy();
  });

  it("formats every known cost in USD without a partial label", () => {
    render(
      <DriverTimeReport
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        canManageDriverPay
        totals={{ ...emptyTotals, drivers: 2, estimatedCost: 1250 }}
        drivers={[
          { cost: { cost: 250, hourlyRate: 20 } },
          { cost: { cost: 1000, hourlyRate: 22 } },
        ]}
        hubGroups={[{ hub: "Dallas", drivers: [], flaggedMinutes: 0 }]}
      />,
    );
    expect(kpi("Estimated cost")).toMatch(/\$1,250/);
    expect(kpi("Estimated cost")).not.toMatch(/Partial/);
    expect(screen.queryByText(/no computed cost/)).toBeNull();
  });

  it("hides cached counts when a later refresh fails", () => {
    render(
      <DriverTimeReport
        isError
        isLoading={false}
        hasData
        errorMessage="timeout"
        onRetry={vi.fn()}
        totals={{ ...emptyTotals, drivers: 6, needsReview: 3, officialDrivers: 2 }}
        hubGroups={[{ hub: "Dallas", drivers: [], flaggedMinutes: 90 }]}
      />,
    );
    expect(screen.getByText(/Report unavailable: timeout/)).toBeTruthy();
    expect(screen.getAllByLabelText("Unavailable")).toHaveLength(4);
    expect(screen.queryByText("Dallas")).toBeNull();
    expect(kpi("Needs review")).not.toMatch(/3/);
    expect(screen.queryByText(/2 driver\(s\) have official/)).toBeNull();
  });
});
