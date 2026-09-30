// READ-ONLY Samsara probe: raw /fleet/hos/logs fields (remarks/annotations). No DB writes.
import { samsaraPaged, fetchDrivers } from "../src/lib/samsara/hos.server";
const drivers = await fetchDrivers();
const find = (n: string) => drivers.filter((d) => d.name.toLowerCase().includes(n));
const targets = [
  { d: find("outler"), s: "2026-09-21T04:00:00Z", e: "2026-09-25T04:00:00Z" },
  { d: find("farahkhan"), s: "2026-09-25T05:00:00Z", e: "2026-09-26T05:00:00Z" },
  { d: find("gilbert"), s: "2026-09-16T05:00:00Z", e: "2026-09-17T05:00:00Z" },
];
const keys = new Set<string>();
for (const t of targets) {
  for (const d of t.d) {
    const p = new URLSearchParams({ startTime: t.s, endTime: t.e, driverIds: d.id });
    const rows = await samsaraPaged<any>(`/fleet/hos/logs?${p}`, (x) => x.data ?? []);
    console.log(`\n=== ${d.name} ${d.id} ${t.s}`);
    for (const r of rows) for (const l of r.hosLogs ?? []) {
      Object.keys(l).forEach((k) => keys.add(k));
      console.log(JSON.stringify(l));
    }
  }
}
console.log("\nALL KEYS:", [...keys].join(","));
