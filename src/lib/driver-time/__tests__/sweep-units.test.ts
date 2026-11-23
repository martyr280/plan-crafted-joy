import "./network-block";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSweepDb, sweepDb } from "./fixtures/sweep-db";

vi.mock("@/integrations/supabase/client.server", async () => ({
  supabaseAdmin: (await import("./fixtures/sweep-db")).sweepDbClient,
}));
vi.mock("@/lib/samsara/hos.server", async () => (await import("./fixtures/sweep-samsara")).samsaraMock);

const cache = await import("@/lib/samsara/cache.server");
const job = await import("@/lib/driver-time/sweep-job.server");
const { centralDaysCovering } = await import("@/lib/samsara/cache-window");

const DAY = centralDaysCovering(Date.parse("2026-09-22T12:00:00Z"), Date.parse("2026-09-22T13:00:00Z"))[0];
const closedNow = Date.parse("2026-11-23T12:00:00Z");

beforeEach(() => resetSweepDb({ samsara_cache_days: [], samsara_cache_rows: [], driver_warehouse_runs: [] }));

describe("5. staged non-GPS cache write", () => {
  it("killed between delete and insert: the day is not served as fresh", async () => {
    const entries = [1, 2, 3].map((i) => ({ entityKind: "driver", entityId: "d1", startMs: DAY.startMs + i * 1000, endMs: DAY.startMs + i * 2000, payload: { i } }));
    await cache.writeCacheDay("hos_logs", DAY, entries, true, null, ["d1"]);
    expect([...(await cache.freshCacheDays("hos_logs", [DAY], ["d1"], Date.now())).keys()]).toEqual([DAY.date]);
    // Die right after the delete (the next call, the first insert, throws).
    sweepDb.hook = (table, op) => {
      if (table === "samsara_cache_rows" && op === "insert") throw new Error("killed");
    };
    await expect(cache.writeCacheDay("hos_logs", DAY, entries, true, null, ["d1"])).rejects.toThrow("killed");
    sweepDb.hook = null;
    const day = sweepDb.tables.samsara_cache_days[0];
    expect(day).toMatchObject({ complete: false, coverage: [] });
    expect((await cache.freshCacheDays("hos_logs", [DAY], ["d1"], Date.now())).size).toBe(0);
  });

  it("a legacy complete-but-partial day (row_count != rows) is stale", async () => {
    sweepDb.tables.samsara_cache_days.push({ id: "day-1", dataset: "gps", day_date: DAY.date, complete: true, coverage: ["v1"], row_count: 10, fetched_at: new Date(closedNow).toISOString() });
    for (let i = 0; i < 4; i++) sweepDb.tables.samsara_cache_rows.push({ id: `r${i}`, day_id: "day-1", dataset: "gps", entity_id: "v1", start_ts: new Date(DAY.startMs + i).toISOString(), payload: {} });
    expect((await cache.freshCacheDays("gps", [DAY], ["v1"], closedNow)).size).toBe(0);
  });

  it("GPS can never go through the replace path", async () => {
    await expect(cache.writeCacheDay("gps", DAY, [], true, null, [])).rejects.toThrow(/append-only/);
  });
});

describe("6. GPS append-only fill", () => {
  it("fills a partial day to the full multiset, a retry inserts 0, nothing is deleted", async () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({ vehicleId: "v1", timeMs: DAY.startMs + i * 60_000, latitude: 30, longitude: -90 }));
    samples.push({ ...samples[3] }); // Samsara duplicate survives
    const dayId = await cache.beginCacheDay("gps", DAY);
    for (const g of samples.slice(0, 5)) sweepDb.tables.samsara_cache_rows.push({ id: `pre-${g.timeMs}`, day_id: dayId, dataset: "gps", entity_id: "v1", start_ts: new Date(g.timeMs).toISOString(), payload: g });
    const ops0 = sweepDb.ops.length;
    const a = await cache.appendGpsChunk(DAY, dayId, ["v1"], samples);
    expect(a).toEqual({ inserted: 8, existing: 5 });
    expect(await cache.countCacheDayRows(dayId)).toBe(13);
    const b = await cache.appendGpsChunk(DAY, dayId, ["v1"], samples);
    expect(b).toEqual({ inserted: 0, existing: 13 });
    expect(sweepDb.ops.slice(ops0).some((o) => o.op === "delete")).toBe(false);
  });
});

function run(id: string, created: string, extra: Record<string, unknown> = {}) {
  return { id, status: "queued", phase: "init", cursor: {}, created_at: created, started_at: created, lease_until: null, heartbeat_at: null, steps: 0, step_log: [], days_fetched: 0, week_start: "2026-09-28", week_end: "2026-10-04", requested_week_start: "2026-09-28", refresh_hos: false, ...extra };
}

describe("7. lease", () => {
  it("two concurrent ticks: exactly one claims the run", async () => {
    sweepDb.tables.driver_warehouse_runs.push(run("r1", "2026-11-23T10:00:00Z"));
    const now = new Date();
    const [a, b] = await Promise.all([job.claimNextRun(now), job.claimNextRun(now)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(sweepDb.tables.driver_warehouse_runs[0].status).toBe("running");
  });
  it("a persist from a tick that lost its lease writes nothing", async () => {
    sweepDb.tables.driver_warehouse_runs.push(run("r1", "2026-11-23T10:00:00Z"));
    const mine = (await job.claimNextRun(new Date()))!;
    sweepDb.tables.driver_warehouse_runs[0].lease_until = new Date(Date.now() + 999_999).toISOString(); // someone else
    const res = await job.persistUnit(mine, { phase: "init", next: "fetch_hos", unit: "x", cursor: {} }, null, new Date(), 1);
    expect(res).toBeNull();
    expect(sweepDb.tables.driver_warehouse_runs[0].phase).toBe("init");
  });
});

describe("8. queue order", () => {
  it("claims the oldest queued run first", async () => {
    sweepDb.tables.driver_warehouse_runs.push(run("newer", "2026-11-23T10:00:05Z"), run("older", "2026-11-23T10:00:01Z"));
    expect((await job.claimNextRun(new Date()))?.id).toBe("older");
  });
});

describe("9. watchdog", () => {
  it("uses the heartbeat, not the start time, and names phase + cursor", async () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const old = "2026-11-23T10:00:00Z";
    const cursor = { roster: [1, 2, 3, 4], detectIdx: 2 };
    sweepDb.tables.driver_warehouse_runs.push(
      run("alive", old, { status: "running", phase: "detect", heartbeat_at: "2026-11-23T11:55:00Z", cursor }),
      run("dead", old, { status: "running", phase: "detect", heartbeat_at: "2026-11-23T11:40:00Z", cursor, last_step: { at: "2026-11-23T11:40:00Z" } }),
      run("legacy", old, { status: "running", phase: null, heartbeat_at: null }),
      run("waiting", old, { status: "queued" }),
    );
    const res = await job.failStalledRuns(now);
    expect(res.failedIds.sort()).toEqual(["dead", "legacy"]);
    const byId = new Map(sweepDb.tables.driver_warehouse_runs.map((r: any) => [r.id, r]));
    expect(byId.get("alive").status).toBe("running");
    expect(byId.get("waiting").status).toBe("queued");
    expect(byId.get("dead").error).toBe("Stalled: no progress for 15 minutes at phase detect, cursor driver 3 of 4, last step 2026-11-23T11:40:00Z");
  });
});

describe("11. run-sql-schedules only enqueues", () => {
  const src = readFileSync(join(__dirname, "../../../routes/api/public/run-sql-schedules.ts"), "utf8");
  it("no runDriverTimeSweep import; Monday block enqueues behind the same dedup guard", () => {
    expect(src).not.toMatch(/runDriverTimeSweep/);
    expect(src).toMatch(/enqueueDriverTimeSweep\(\{ now, triggeredBy: null \}\)/);
    expect(src).toMatch(/already_swept_today/);
  });
  it("enqueue dedups an active run for the same scheduled week", async () => {
    const now = new Date("2026-11-23T14:05:00Z");
    const a = await job.enqueueDriverTimeSweep({ now });
    const b = await job.enqueueDriverTimeSweep({ now });
    expect(b).toMatchObject({ runId: a.runId, existing: true, weekStart: "2026-11-16" });
    expect(sweepDb.tables.driver_warehouse_runs).toHaveLength(1);
    expect(sweepDb.tables.driver_warehouse_runs[0]).toMatchObject({ status: "queued", phase: "init", requested_week_start: null });
  });
});

describe("15. wiring: keyset reads, no OFFSET", () => {
  const src = readFileSync(join(__dirname, "../../samsara/cache.server.ts"), "utf8");
  const body = (name: string) => src.slice(src.indexOf(`export async function ${name}`), src.indexOf("\n}\n", src.indexOf(`export async function ${name}`)));
  it("readEntityRows / appendGpsChunk use no .range()", () => {
    expect(body("readEntityRows")).not.toMatch(/\.range\(/);
    expect(body("appendGpsChunk")).not.toMatch(/\.range\(/);
    expect(body("readEntityRows")).toMatch(/start_ts\.gt\./);
  });
  it("readEntityRows pages by (start_ts, id) keyset over > 1,000 rows and returns id order", async () => {
    const dayId = "d-1";
    for (let i = 0; i < 2500; i++)
      sweepDb.tables.samsara_cache_rows.push({ id: `id-${String((i * 7919) % 2500).padStart(5, "0")}`, day_id: dayId, dataset: "gps", entity_id: "v1", start_ts: new Date(DAY.startMs + Math.floor(i / 3) * 1000).toISOString(), payload: { i } });
    const rows = await cache.readEntityRows<{ i: number }>("gps", "v1", [dayId]);
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.i)).size).toBe(2500);
    const ops = sweepDb.ops.filter((o) => o.table === "samsara_cache_rows");
    expect(ops.some((o) => o.range)).toBe(false);
    expect(ops.filter((o) => o.or).length).toBe(2);
  });
});
