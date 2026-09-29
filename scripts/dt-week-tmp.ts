import { runDriverTimeSweep } from "../src/lib/driver-time.server";
const w = process.argv[2];
const r: any = await runDriverTimeSweep({ weekStart: w, triggeredBy: null });
console.log("RESULT", w, JSON.stringify({ runId: r.runId, drivers: r.driversScanned, events: r.eventsFound, ins: r.inserted, upd: r.updated, warnings: r.warnings }));
