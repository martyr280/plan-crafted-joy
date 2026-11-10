// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DispatchListAlert, RunDetailAlert } from "../RunDetailAlert";
import { dispatchListPanels, dispatchRunPanels } from "../run-detail-panels";

describe("dispatch run detail failure", () => {
  it("shows the error and retries without treating a previous load as current", () => {
    const onRetry = vi.fn();
    const panels = dispatchRunPanels({ isError: true, isLoading: false, hasData: true });
    expect(panels.showRun).toBe(false);
    expect(panels.allowSendOrPrint).toBe(false);
    expect(panels.showStaleNote).toBe(true);
    render(
      <RunDetailAlert message="Dispatch stops unavailable: timeout" stale onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/timeout/);
    expect(screen.getByText(/stale pallet total is not shown/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("a first-load failure is an error, not an empty run", () => {
    const panels = dispatchRunPanels({ isError: true, isLoading: false, hasData: false });
    expect(panels.showError).toBe(true);
    expect(panels.showRun).toBe(false);
    expect(panels.showLoading).toBe(false);
  });
});

describe("dispatch runs list failure", () => {
  it("shows the error and retries, and does not treat zero or a previous list as current", () => {
    const onRetry = vi.fn();
    const failedEmpty = dispatchListPanels({ isError: true, isLoading: false, hasData: false });
    expect(failedEmpty.showError).toBe(true);
    expect(failedEmpty.showKpiNumbers).toBe(false);
    expect(failedEmpty.showRows).toBe(false);
    expect(failedEmpty.allowRowActions).toBe(false);

    const failedStale = dispatchListPanels({ isError: true, isLoading: false, hasData: true });
    expect(failedStale.showStaleNote).toBe(true);
    expect(failedStale.showRows).toBe(false);
    expect(failedStale.allowRowActions).toBe(false);
    expect(failedStale.showKpiNumbers).toBe(false);

    render(
      <DispatchListAlert message="Dispatch runs unavailable: timeout" stale onRetry={onRetry} />,
    );
    const alert = screen.getByTestId("dispatch-runs-error");
    expect(alert.textContent).toMatch(/timeout/);
    expect(alert.textContent).toMatch(/stale routes and pallet totals are not shown/);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("a successful list shows counts and allows row actions", () => {
    const panels = dispatchListPanels({ isError: false, isLoading: false, hasData: true });
    expect(panels.showKpiNumbers).toBe(true);
    expect(panels.showRows).toBe(true);
    expect(panels.allowRowActions).toBe(true);
    expect(panels.showError).toBe(false);
  });
});
