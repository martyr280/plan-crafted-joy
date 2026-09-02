// Regression guard for WP-6: the theme tokens in src/styles.css are full
// oklch() values, so wrapping one in an hsl() function produces invalid CSS.
// In SVG an invalid presentation attribute falls back to its initial value
// (stroke -> none, fill -> black), which made every Recharts series invisible.
// Charts must reference tokens directly, e.g. stroke="var(--primary)".
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const EXT = /\.(ts|tsx)$/;
// Assembled at runtime so this guard file does not match itself.
const BAD = "hsl" + "(var(--";
const SELF = "no-hsl-var-tokens.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(entry) && !full.endsWith(SELF)) out.push(full);
  }
  return out;
}

describe("theme tokens in chart code", () => {
  it("never wraps an oklch design token in an hsl() function", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.includes(BAD)) {
            hits.push(`${file.slice(SRC.length - 3)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      hits,
      `Found ${hits.length} hsl-wrapped token usage(s). Tokens are oklch(); use var(--x) directly:\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
