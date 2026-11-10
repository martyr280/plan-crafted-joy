import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .map((name) => join(dir, name));
}

const touchedDriverTime = ["DriverCard.tsx", "DriverRatesPanel.tsx", "text-classes.ts"].map(
  (name) => join(process.cwd(), "src/components/driver-time", name),
);
const touchedTruckCapacity = [
  "EstPalletsTrigger.tsx",
  "ForecastBoard.tsx",
  "ForecastBoardTable.tsx",
].map((name) => join(process.cwd(), "src/components/truck-capacity", name));

const files = [
  join(process.cwd(), "src/routes/_app.dispatch.tsx"),
  join(process.cwd(), "src/routes/_app.driver-time.tsx"),
  ...sourceFiles(join(process.cwd(), "src/components/dispatch")),
  ...touchedDriverTime,
  ...touchedTruckCapacity,
];

// Raw fill utilities used as text. text-destructive-text and text-warning-text stay allowed.
const rawFillText = /text-destructive(?!-text\b|-foreground\b)|text-amber-\d+/;

describe("dispatch, driver-time, and truck-capacity text colors", () => {
  it("does not use a destructive or amber fill as text", () => {
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return rawFillText.test(text) ? [file] : [];
    });
    expect(hits).toEqual([]);
  });
});
