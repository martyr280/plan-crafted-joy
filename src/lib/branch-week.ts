// Monday (America/Chicago) that starts the current reporting week.
export function currentMonday(now = new Date()): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const x = new Date(local + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() - (x.getUTCDay() === 0 ? 6 : x.getUTCDay() - 1));
  return x.toISOString().slice(0, 10);
}
