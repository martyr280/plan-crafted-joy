import { runDriverTimeSweep } from "../src/lib/driver-time.server";

console.log("=== Sweep 1: weekStart 2026-09-07 ===");
console.log(JSON.stringify(await runDriverTimeSweep({ weekStart: "2026-09-07", triggeredBy: null }), null, 2));

console.log("=== Sweep 2: default trailing 8-day window ===");
console.log(JSON.stringify(await runDriverTimeSweep({ triggeredBy: null }), null, 2));
