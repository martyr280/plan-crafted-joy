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
