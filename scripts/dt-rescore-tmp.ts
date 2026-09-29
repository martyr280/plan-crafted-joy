import { runDriverTimeSweep } from "../src/lib/driver-time.server";
for (const weekStart of ["2026-09-07","2026-09-14","2026-09-21"]) {
  const r = await runDriverTimeSweep({ weekStart, triggeredBy: null });
  console.log(weekStart, JSON.stringify({ runId: (r as any).runId, status: (r as any).status, drivers: (r as any).driversScanned, events: (r as any).eventsFound, ins: (r as any).inserted, upd: (r as any).updated, warnings: (r as any).warnings }));
}
