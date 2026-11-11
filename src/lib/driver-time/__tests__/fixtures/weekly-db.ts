// Synthetic in-memory stand-in for the service-role client used by
// getDriverTimeWeek. Reads filter local rows; every write or unknown RPC throws.
// No network, no credentials, no real driver data.

type Row = Record<string, unknown>;

export const weeklyDb = {
  tables: {} as Record<string, Row[]>,
  roles: new Set<string>(),
  reads: [] as string[],
  writes: 0,
};

export function resetWeeklyDb(roles: string[], tables: Record<string, Row[]>) {
  weeklyDb.tables = tables;
  weeklyDb.roles = new Set(roles);
  weeklyDb.reads = [];
  weeklyDb.writes = 0;
}

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let limit = Infinity;
  const result = (from = 0, to = Infinity) => {
    weeklyDb.reads.push(table);
    const all = (weeklyDb.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const data = all.slice(0, limit).slice(from, to + 1);
    return { data, error: null, count: all.length };
  };
  const deny = () => {
    weeklyDb.writes++;
    throw new Error(`No writes allowed: ${table}`);
  };
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => {
      filters.push((r) => r[k] === v);
      return q;
    },
    gte: (k: string, v: string) => {
      filters.push((r) => String(r[k]) >= v);
      return q;
    },
    lte: (k: string, v: string) => {
      filters.push((r) => String(r[k]) <= v);
      return q;
    },
    order: () => q,
    limit: (n: number) => {
      limit = n;
      return q;
    },
    range: async (from: number, to: number) => result(from, to),
    maybeSingle: async () => {
      const r = result();
      return { ...r, data: r.data[0] ?? null };
    },
    then: <T>(resolve: (v: ReturnType<typeof result>) => T, reject?: (e: unknown) => T) =>
      Promise.resolve(result()).then(resolve, reject),
    insert: deny,
    update: deny,
    upsert: deny,
    delete: deny,
  };
  return q;
}

export const supabaseAdminMock = {
  from: (table: string) => query(table),
  rpc: async (fn: string, args: { _user_id?: string; _role?: string }) => {
    if (fn !== "has_role") {
      weeklyDb.writes++;
      throw new Error(`Unexpected RPC ${fn}`);
    }
    return { data: weeklyDb.roles.has(String(args._role)), error: null };
  },
};

/** createServerFn stand-in that keeps the real input validator and handler. */
export function serverFnChain() {
  let validate: (input: unknown) => unknown = (i) => i;
  const chain = {
    middleware: () => chain,
    inputValidator: (fn: (input: unknown) => unknown) => {
      validate = fn;
      return chain;
    },
    handler:
      (fn: (ctx: { data: unknown; context: { userId: string } }) => unknown) =>
      (input: { data?: unknown; context: { userId: string } }) =>
        fn({ data: validate(input.data), context: input.context }),
  };
  return chain;
}

export const WEEK = { start: "2026-11-09", monday: "2026-11-09", tuesday: "2026-11-10" };

export type Category = "F" | "P" | "U" | "M" | "Z0" | "ZM";

const NAMES: Record<Category, string> = {
  F: "Faith Fullrate",
  P: "Pat Partday",
  U: "Uma Unrated",
  M: "Max Nopaycom",
  Z0: "Zed Knownzero",
  ZM: "Zia Zeromissing",
};

export const driverName = (c: Category) => NAMES[c];

let eventSeq = 0;
function event(driver: Category, date: string, minutes: number): Row {
  eventSeq += 1;
  const start = `${date}T14:00:00Z`;
  return {
    id: `ev-${driver}-${eventSeq}`,
    driver_id: `drv-${driver}`,
    driver_name: NAMES[driver],
    event_date: date,
    start_ts: start,
    end_ts: new Date(Date.parse(start) + minutes * 60000).toISOString(),
    duration_min: minutes,
    hub: "Dallas",
    address_name: "Dallas warehouse",
    location_source: "log",
    status: "reviewed",
    needs_review: false,
    superseded_at: null,
    notes: null,
  };
}

function rate(driver: Category, effective: string): Row {
  return {
    id: `rate-${driver}`,
    driver_id: `drv-${driver}`,
    driver_name: NAMES[driver],
    hourly_rate: 20,
    effective_date: effective,
    updated_at: "2026-11-01T00:00:00Z",
  };
}

function paycom(driver: Category, hours: number): Row {
  return {
    id: `ovr-${driver}`,
    driver_id: `drv-${driver}`,
    week_start: WEEK.start,
    paycom_hours: hours,
    warehouse_actual: null,
    updated_at: "2026-11-10T00:00:00Z",
  };
}

/**
 * F: Paycom 39h, $20 from before the week, 120 Tuesday minutes.
 * P: Paycom 39h, $20 only from Tuesday, 120 Monday + 120 Tuesday minutes.
 * U: Paycom 39h, no rate, 120 Tuesday minutes.
 * M: no Paycom row, $20 from before the week, 120 Tuesday minutes.
 * Z0: Paycom 39h, $20, one zero-minute block. ZM: no Paycom, $20, zero minutes.
 */
export function weekTables(
  mix: Category[],
  extra: { runs?: Row[]; mMinutesByDay?: Record<string, number> } = {},
) {
  const events: Row[] = [];
  const overrides: Row[] = [];
  const rates: Row[] = [];
  for (const c of mix) {
    if (c === "F") {
      events.push(event(c, WEEK.tuesday, 120));
      rates.push(rate(c, "2026-11-01"));
      overrides.push(paycom(c, 39));
    } else if (c === "P") {
      events.push(event(c, WEEK.monday, 120), event(c, WEEK.tuesday, 120));
      rates.push(rate(c, WEEK.tuesday));
      overrides.push(paycom(c, 39));
    } else if (c === "U") {
      events.push(event(c, WEEK.tuesday, 120));
      overrides.push(paycom(c, 39));
    } else if (c === "M") {
      const byDay = extra.mMinutesByDay ?? { [WEEK.tuesday]: 120 };
      for (const [date, minutes] of Object.entries(byDay)) events.push(event(c, date, minutes));
      rates.push(rate(c, "2026-11-01"));
    } else if (c === "Z0") {
      events.push(event(c, WEEK.tuesday, 0));
      rates.push(rate(c, "2026-11-01"));
      overrides.push(paycom(c, 39));
    } else {
      events.push(event(c, WEEK.tuesday, 0));
      rates.push(rate(c, "2026-11-01"));
    }
  }
  return {
    driver_warehouse_events: events,
    driver_time_week_overrides: overrides,
    driver_pay_rates: rates,
    driver_warehouse_runs: extra.runs ?? [],
    app_settings: [],
  };
}
