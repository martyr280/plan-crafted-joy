// Regression guard for WP-6: the theme tokens in src/styles.css are full
// oklch() values, so `hsl(var(--x))` expands to `hsl(oklch(...))` — invalid CSS.
// In SVG an invalid presentation attribute falls back to its initial value
// (stroke -> none, fill -> black), which made every Recharts series invisible.
// Charts must reference tokens directly: `var(--x)`.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const EXT = /\.(ts|tsx)$/;
const BAD = "hsl(var(--";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(entry)) out.push(full);
  }
  return out;
}

describe("theme tokens in chart code", () => {
  it("never wraps an oklch design token in hsl()", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes(BAD)) {
          hits.push(`${file.slice(SRC.length - 3)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      hits,
      `Found ${hits.length} hsl(var(--…)) usage(s). Tokens are oklch(); use var(--x) directly:\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
