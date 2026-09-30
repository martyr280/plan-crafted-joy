// Approved 2026-09-30: refresh ONLY hos_logs cache days 2026-09-07..2026-09-25.
import { fetchDrivers } from "../src/lib/samsara/hos.server";
import { filterRoster, getDriverTimeSettings } from "../src/lib/driver-time.server";
import { getHosSegments } from "../src/lib/samsara/cache.server";
const s = await getDriverTimeSettings();
const { roster } = filterRoster(await fetchDrivers(), s);
const r = await getHosSegments({ startMs: Date.parse("2026-09-07T05:00:00Z"), endMs: Date.parse("2026-09-26T04:59:59Z"), driverIds: roster.map((d) => d.id), refresh: true });
console.log(JSON.stringify(r.stat), "remarks:", r.segments.filter((x) => x.remark).length);
