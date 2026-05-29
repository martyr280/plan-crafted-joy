// Tiny helpers to translate between cron expressions and a human-friendly
// schedule builder. Supports the patterns the builder produces; falls back
// to "custom" for anything else (user can still hand-edit the cron).

export type Frequency = "minutely" | "hourly" | "daily" | "weekly" | "monthly" | "custom";

export type HumanSchedule = {
  frequency: Frequency;
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0=Sun .. 6=Sat
  day: number; // 1-31
  cron: string; // raw cron when frequency === "custom"
};

export const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

export function defaultHuman(): HumanSchedule {
  return { frequency: "weekly", hour: 8, minute: 0, weekday: 1, day: 1, cron: "0 8 * * 1" };
}

export function toCron(h: HumanSchedule): string {
  const mm = clamp(h.minute, 0, 59);
  const hh = clamp(h.hour, 0, 23);
  switch (h.frequency) {
    case "minutely": return "* * * * *";
    case "hourly":   return `${mm} * * * *`;
    case "daily":    return `${mm} ${hh} * * *`;
    case "weekly":   return `${mm} ${hh} * * ${clamp(h.weekday, 0, 6)}`;
    case "monthly":  return `${mm} ${hh} ${clamp(h.day, 1, 31)} * *`;
    case "custom":   return h.cron.trim() || "0 8 * * 1";
  }
}

export function fromCron(cron: string): HumanSchedule {
  const base = defaultHuman();
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { ...base, frequency: "custom", cron };
  const [m, hr, dom, mon, dow] = parts;
  const mNum = num(m), hNum = num(hr), domNum = num(dom), dowNum = num(dow);

  if (mon !== "*") return { ...base, frequency: "custom", cron };

  // Every minute
  if (m === "*" && hr === "*" && dom === "*" && dow === "*") {
    return { ...base, frequency: "minutely", cron };
  }
  // Hourly at :mm
  if (mNum !== null && hr === "*" && dom === "*" && dow === "*") {
    return { ...base, frequency: "hourly", minute: mNum, cron };
  }
  // Daily at hh:mm
  if (mNum !== null && hNum !== null && dom === "*" && dow === "*") {
    return { ...base, frequency: "daily", minute: mNum, hour: hNum, cron };
  }
  // Weekly
  if (mNum !== null && hNum !== null && dom === "*" && dowNum !== null) {
    return { ...base, frequency: "weekly", minute: mNum, hour: hNum, weekday: dowNum, cron };
  }
  // Monthly
  if (mNum !== null && hNum !== null && domNum !== null && dow === "*") {
    return { ...base, frequency: "monthly", minute: mNum, hour: hNum, day: domNum, cron };
  }
  return { ...base, frequency: "custom", cron };
}

export function describeCron(cron: string): string {
  const h = fromCron(cron);
  const time = `${pad(h.hour)}:${pad(h.minute)}`;
  switch (h.frequency) {
    case "minutely": return "Every minute";
    case "hourly":   return `Every hour at :${pad(h.minute)}`;
    case "daily":    return `Every day at ${time}`;
    case "weekly":   return `Every ${WEEKDAYS[h.weekday]?.label ?? "?"} at ${time}`;
    case "monthly":  return `Day ${h.day} of each month at ${time}`;
    case "custom":   return `Custom (${cron})`;
  }
}

function clamp(n: number, lo: number, hi: number) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
function num(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  return Number(s);
}
function pad(n: number) { return String(n).padStart(2, "0"); }
