// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { DispatchRunsBoard, type DispatchBoardRoute } from "../DispatchRunsBoard";

const route: DispatchBoardRoute = {
  routeId: "r1",
  code: "OKL",
  name: "Oklahoma City long route name",
  hub: "Dallas",
  enabled: true,
  runs: [{ id: "run-1", runDate: "2026-11-12", status: "planned", stopsHeld: 1 }],
};

function board(props: Partial<ComponentProps<typeof DispatchRunsBoard>> = {}) {
  return render(
    <DispatchRunsBoard
      isError={false}
      isLoading={false}
      hasData={false}
      onRetry={vi.fn()}
      rows={[]}
      canWrite
      onOpenRun={vi.fn()}
      onBuild={vi.fn()}
      {...props}
    />,
  );
}

afterEach(() => cleanup());

function kpiText(label: string) {
  return screen.getByText(label).parentElement?.textContent ?? "";
}

describe("dispatch runs board", () => {
  it("shows a loading status and no zero KPIs or build actions before the first success", () => {
    board({ isLoading: true, isFetching: true, hasData: false });
    expect(screen.getByRole("status").textContent).toMatch(/Loading dispatch runs/);
    expect(kpiText("Routes enabled")).not.toMatch(/0/);
    expect(kpiText("Runs planned")).not.toMatch(/0/);
    expect(kpiText("Runs pushed")).not.toMatch(/0/);
    expect(kpiText("Stops held")).not.toMatch(/0/);
    expect(screen.queryByRole("button", { name: /Build now/ })).toBeNull();
  });

  it("keeps numbers blank on a failed first load, then a retry, then shows a successful count", () => {
    const onRetry = vi.fn();
    const view = board({ isError: true, hasData: false, errorMessage: "timeout", onRetry });
    expect(screen.getByTestId("dispatch-runs-error").textContent).toMatch(/timeout/);
    expect(kpiText("Routes enabled")).not.toMatch(/0/);
    expect(screen.queryByRole("button", { name: /Build now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();

    view.rerender(
      <DispatchRunsBoard
        isError
        isLoading={false}
        isFetching
        hasData={false}
        errorMessage="timeout"
        onRetry={onRetry}
        rows={[]}
        canWrite
        onOpenRun={vi.fn()}
        onBuild={vi.fn()}
      />,
    );
    expect(kpiText("Routes enabled")).not.toMatch(/0/);
    expect(screen.queryByRole("button", { name: /Build now/ })).toBeNull();

    view.rerender(
      <DispatchRunsBoard
        isError={false}
        isLoading={false}
        hasData
        onRetry={onRetry}
        rows={[route]}
        canWrite
        onOpenRun={vi.fn()}
        onBuild={vi.fn()}
      />,
    );
    expect(kpiText("Routes enabled")).toMatch(/1/);
    expect(screen.getByRole("button", { name: /Build now/ })).toBeTruthy();
  });

  it("hides a cached list and its actions when a refresh fails, and shows a real zero only after an empty success", () => {
    const onBuild = vi.fn();
    const view = board({
      isError: true,
      hasData: true,
      errorMessage: "timeout",
      rows: [route],
      onBuild,
    });
    expect(screen.getByText(/stale routes and pallet totals are not shown/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Build now/ })).toBeNull();
    expect(screen.queryByText("OKL")).toBeNull();
    expect(kpiText("Routes enabled")).not.toMatch(/1|0/);

    view.rerender(
      <DispatchRunsBoard
        isError={false}
        isLoading={false}
        hasData
        onRetry={vi.fn()}
        rows={[]}
        canWrite
        onOpenRun={vi.fn()}
        onBuild={onBuild}
      />,
    );
    expect(kpiText("Routes enabled")).toMatch(/0/);
    expect(onBuild).not.toHaveBeenCalled();
  });

  it("keeps no-run and reduced-run warnings on the list", () => {
    board({
      isError: false,
      hasData: true,
      rows: [
        {
          ...route,
          runs: [
            {
              id: "run-1",
              runDate: "2026-11-12",
              status: "cancelled",
              stopsHeld: 0,
              exception: { kind: "no_run", badge: "No run", message: "Tickets roll forward" },
            },
            {
              id: "run-2",
              runDate: "2026-11-13",
              status: "locked",
              stopsHeld: 2,
              exception: { kind: "reduced", badge: "Reduced", message: "Short a driver" },
            },
          ],
        },
      ],
    });
    const noRun = screen.getByText("No run");
    const reduced = screen.getByText("Reduced");
    expect(noRun.getAttribute("title")).toBe("Tickets roll forward");
    expect(noRun.className).toMatch(/text-destructive-text/);
    expect(noRun.className).not.toMatch(/text-destructive(?!-text)/);
    expect(reduced.getAttribute("title")).toBe("Short a driver");
    expect(reduced.className).toMatch(/text-warning-text/);
    expect(reduced.className).not.toMatch(/text-amber-\d+/);
    expect(screen.getByText("cancelled").className).toMatch(/text-destructive-text/);
    expect(screen.getByText("cancelled").className).not.toMatch(/text-destructive(?!-text)/);
    expect(screen.getByText("locked").className).toMatch(/text-warning-text/);
    expect(screen.getByText("2 held").className).toMatch(/text-warning-text/);
    expect(screen.getByText("2 held").className).not.toMatch(/text-amber-\d+/);
  });
});
