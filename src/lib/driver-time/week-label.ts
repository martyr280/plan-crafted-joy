// Week label for the scheduled (cron) Driver Time sweep. Pure, no I/O.
//
// The Monday 8 AM Central sweep reports on the week that just ended, so the
// label is the Monday (America/Chicago) of the week containing
// (run's Central calendar date − 7 days). It is computed from the run's local
// date only — never from the scan window arithmetic.

import { CENTRAL_TZ, dateStrInTz } from "@/lib/tz";

export function scheduledSweepWeek(runAt: Date): { weekStart: string; weekEnd: string } {
  const local = dateStrInTz(runAt, CENTRAL_TZ);
  const x = new Date(`${local}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 7);
  const dow = x.getUTCDay(); // 0=Sun
  x.setUTCDate(x.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  const end = new Date(x);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart: x.toISOString().slice(0, 10), weekEnd: end.toISOString().slice(0, 10) };
}
