// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EstPalletsTrigger } from "../EstPalletsTrigger";

describe("estimated pallet trigger", () => {
  it("is a labelled button and does not activate the row behind it", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <EstPalletsTrigger code="OKL" estPallets={13} />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: /OKL estimated pallets: 13/i });
    expect(trigger.tagName).toBe("BUTTON");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(onRow).not.toHaveBeenCalled();
  });
});
