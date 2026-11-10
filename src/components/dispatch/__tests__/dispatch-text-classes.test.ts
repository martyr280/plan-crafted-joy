import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every non-test source file in this PR. Tests are excluded because they name the forbidden classes. */
const touchedSource = [
  "scripts/tc-run-snapshot.ts",
  "src/components/dispatch/DispatchRunsBoard.tsx",
  "src/components/dispatch/LoadSheetView.tsx",
  "src/components/dispatch/RunDetailAlert.tsx",
  "src/components/dispatch/TicketBoard.tsx",
  "src/components/dispatch/run-detail-panels.ts",
  "src/components/driver-time/DriverCard.tsx",
  "src/components/driver-time/DriverRatesPanel.tsx",
  "src/components/driver-time/DriverTimeReport.tsx",
  "src/components/driver-time/text-classes.ts",
  "src/components/truck-capacity/EstPalletsTrigger.tsx",
  "src/components/truck-capacity/ForecastBoard.tsx",
  "src/components/truck-capacity/ForecastBoardTable.tsx",
  "src/lib/branch-logistics.server.ts",
  "src/lib/dispatch.functions.ts",
  "src/lib/dispatch.server.ts",
  "src/lib/dispatch/board.ts",
  "src/lib/dispatch/build.ts",
  "src/lib/dispatch/loadsheet.ts",
  "src/lib/dispatch/pallets.ts",
  "src/lib/driver-time.functions.ts",
  "src/lib/driver-time/access.ts",
  "src/lib/driver-time/report-panels.ts",
  "src/lib/driver-time/rates.ts",
  "src/lib/truck-capacity.functions.ts",
  "src/lib/truck-capacity.server.ts",
  "src/lib/truck-capacity/board.ts",
  "src/lib/truck-capacity/capacity-save.ts",
  "src/lib/truck-capacity/est-pallets.ts",
  "src/lib/truck-capacity/serve.ts",
  "src/routes/_app.dispatch.tsx",
  "src/routes/_app.driver-time.tsx",
  "src/routes/_app.truck-capacity.tsx",
];

const files = touchedSource.map((file) => join(process.cwd(), file));

// Raw palette utilities used as text. Semantic text tokens stay allowed.
const rawFillText =
  /text-(?:destructive(?!-text\b|-foreground\b)|(?:red|amber|yellow|orange|green|emerald)-\d+)/;

describe("PR text colors", () => {
  it("covers the truck-capacity route and every other non-test file in the PR", () => {
    expect(touchedSource).toContain("src/routes/_app.truck-capacity.tsx");
    expect(touchedSource).toContain("src/routes/_app.driver-time.tsx");
    expect(touchedSource).toContain("src/routes/_app.dispatch.tsx");
  });

  it("does not use a destructive, red, amber, yellow, or orange fill as text", () => {
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return rawFillText.test(text) ? [file] : [];
    });
    expect(hits).toEqual([]);
  });
});
