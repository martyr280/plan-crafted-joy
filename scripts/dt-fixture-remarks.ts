// Builds regression fixtures (READ-ONLY Samsara + read of cached GPS/assignments). No DB writes except none.
import { writeFileSync, readFileSync } from "fs";
import { fetchHosLogs, fetchDriverVehicleAssignments, fetchVehicleGpsHistory } from "../src/lib/samsara/hos.server";
import { backfillSegmentVehicles, dominantVehiclePerDriverDay } from "../src/lib/samsara/cache-window";
const base = JSON.parse(readFileSync("src/lib/driver-time/__tests__/fixtures/outler-2026-09-17.json", "utf8"));
const id = "53243882";
for (const date of ["2026-09-21", "2026-09-22", "2026-09-24"]) {
  const s = Date.parse(`${date}T04:00:00Z`), e = s + 86400000;
  const segs = await fetchHosLogs({ startMs: s, endMs: e, driverIds: [id] });
  const asg = (await fetchDriverVehicleAssignments({ startMs: s, endMs: e, driverIds: [id] })).map((a: any) => ({ driverId: a.driverId, vehicleId: a.vehicleId, startMs: a.startMs, endMs: a.endMs }));
  const { segments } = backfillSegmentVehicles(segs, asg, dominantVehiclePerDriverDay(asg));
  const vids = [...new Set(segments.map((x) => x.vehicleId).filter((v) => v && v !== "0"))] as string[];
  const gps = await fetchVehicleGpsHistory({ startMs: s, endMs: e, vehicleIds: vids });
  writeFileSync(`src/lib/driver-time/__tests__/fixtures/outler-${date}.json`, JSON.stringify({ ...base, tzOffsetMinutes: -240, segments, gps }));
  console.log(date, segments.length, gps.length, segments.filter((x) => x.remark).map((x) => x.remark));
}
