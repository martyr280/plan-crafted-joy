// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ForecastBoardTable, type ForecastTableRow } from "../ForecastBoardTable";

const row: ForecastTableRow = {
  route_id: "route-okl",
  code: "OKL",
  name: "Oklahoma City to the long western stops",
  cutoff_count: 1,
  next_cutoff: {
    localDate: "2026-11-12",
    timeLabel: "2:00 PM",
    isToday: false,
    isTomorrow: true,
    daysAway: 1,
    runDates: ["2026-11-12"],
    windowFrom: "2026-11-11",
  },
  final: 0.5,
  current: 0.5,
  method: "baseline",
  mad: 0.1,
  forecast_error: null,
  est_pallets: 13,
  last_run: null,
};

describe("forecast route keyboard opening", () => {
  it("opens the route from the labelled button and not from the pallet formula", () => {
    const onSelect = vi.fn();
    render(<ForecastBoardTable rows={[row]} onSelectRoute={onSelect} />);
    const formula = screen.getByTestId("est-pallets-OKL");
    const open = screen.getByRole("button", { name: /Open route OKL, Oklahoma City/ });
    formula.focus();
    fireEvent.keyDown(formula, { key: "Enter" });
    fireEvent.click(formula);
    expect(onSelect).not.toHaveBeenCalled();
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    expect(onSelect).toHaveBeenCalledWith("route-okl");
  });
});
