// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RunDetailAlert } from "../RunDetailAlert";
import { dispatchRunPanels } from "../run-detail-panels";

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
