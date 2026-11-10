import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dispatchDir = join(process.cwd(), "src/components/dispatch");
const files = [
  join(process.cwd(), "src/routes/_app.dispatch.tsx"),
  ...readdirSync(dispatchDir)
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .map((name) => join(dispatchDir, name)),
];

// Raw fill utilities used as text. text-destructive-text and text-warning-text stay allowed.
const rawFillText = /text-destructive(?!-text\b|-foreground\b)|text-amber-\d+/;

describe("dispatch text colors", () => {
  it("does not use a destructive or amber fill as text", () => {
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return rawFillText.test(text) ? [file] : [];
    });
    expect(hits).toEqual([]);
  });
});
