import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("toast error-text override targets Sonner's real attribute", () => {
  it("sonner dist uses data-sonner-theme and styles.css uses exactly that with :root", () => {
    const js = readFileSync("node_modules/sonner/dist/index.mjs", "utf8");
    expect(js).toContain("data-sonner-theme");
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toContain(':root [data-sonner-toaster][data-sonner-theme="light"] {');
    expect(css).not.toMatch(/\[data-theme="light"\]/);
  });
});
