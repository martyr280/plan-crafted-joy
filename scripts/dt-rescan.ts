import { runDriverTimeSweep } from "../src/lib/driver-time.server";

const weeks = ["2026-08-17", "2026-08-24", "2026-08-31"];

for (const weekStart of weeks) {
  const result = await runDriverTimeSweep({ weekStart, triggeredBy: null });
  console.log(JSON.stringify(result, null, 2));
}