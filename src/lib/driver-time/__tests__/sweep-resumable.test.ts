import "./network-block";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KilledError, killAfter, resetSweepDb, revive, sweepDb } from "./fixtures/sweep-db";
import { loadWeek } from "./fixtures/sweep-samsara";

// Parity: the resumable sweep vs the OLD single-shot sweep, kept verbatim in
// fixtures/sweep-legacy.ts (+ cache-legacy.ts, detect-legacy.ts). Same fake
// database, same synthetic Samsara (real fixtures for Outler 9/21, 9/22, 9/24,
// Farahkhan 9/16 and McGinnis 9/11 shifted into the week of 2026-09-21, plus a
// synthetic blank-vehicle driver). No network, no real data.

vi.mock("@/integrations/supabase/client.server", async () => ({
  supabaseAdmin: (await import("./fixtures/sweep-db")).sweepDbClient,
}));
vi.mock("@/lib/samsara/hos.server", async () => (await import("./fixtures/sweep-samsara")).samsaraMock);

const WEEK = "2026-09-21";

function seedTables(fenceIds: string[], events: any[] = []) {
  return {
    app_settings: [{ key: "driver_time", value: { warehouseAddressIds: fenceIds }, updated_at: "2026-09-01T00:00:00Z" }],
    driver_warehouse_runs: [],
    driver_warehouse_events: events,
    samsara_cache_days: [],
    samsara_cache_rows: [],
  };
}

function normEvents(rows: any[]) {
  return rows
    .map(({ id, run_id, created_at, updated_at, superseded_at, ...rest }) => ({ ...rest, superseded: superseded_at != null }))
    .sort((a, b) => `${a.driver_id}|${a.start_ts}`.localeCompare(`${b.driver_id}|${b.start_ts}`));
}
function normRun(r: any) {
  return { status: r.status, drivers_scanned: r.drivers_scanned, events_found: r.events_found, error: r.error ?? null };
}
function cacheMultiset(rows: any[]) {
  return rows
    .map((r) => `${r.dataset}|${r.day_date}|${r.entity_id}|${r.start_ts}|${JSON.stringify(r.payload)}`)
    .sort();
}

async function legacySweep() {
  const legacy = await import("./fixtures/sweep-legacy");
  return legacy.runDriverTimeSweep({ weekStart: WEEK });
}
async function newSweep() {
  const mod = await import("@/lib/driver-time.server");
  return mod.runDriverTimeSweep({ weekStart: WEEK });
}

/** Seed: run the legacy sweep on an empty DB, then perturb its output. */
async function buildSeed(small = false) {
  const { fenceIds } = loadWeek({ small });
  resetSweepDb(seedTables(fenceIds));
  await legacySweep();
  const first = sweepDb.tables.driver_warehouse_events.map((e) => ({ ...e }));
  expect(first.length).toBeGreaterThan(0);
  const seeded = first.map((e, i) =>
    i === 0 ? { ...e, duration_min: e.duration_min + 7, status: "reviewed", reviewed_by: "u-1", reviewed_at: "2026-09-29T00:00:00Z" } : { ...e },
  );
  seeded.push(
    // stale: inside the window, no longer detected -> retired
    { id: "stale-1", driver_id: String(first[0].driver_id), driver_name: "x", event_date: "2026-09-23", start_ts: "2026-09-23T15:00:00.000Z", end_ts: "2026-09-23T17:00:00.000Z", duration_min: 120, status: "reviewed", superseded_at: null, run_id: "old-run" },
    // known but unlicensed driver -> retirable
    { id: "known-1", driver_id: "nolic-1", driver_name: "y", event_date: "2026-09-22", start_ts: "2026-09-22T15:00:00.000Z", end_ts: "2026-09-22T17:00:00.000Z", duration_min: 120, status: "new", superseded_at: null, run_id: "old-run" },
    // before the window, reviewed -> untouched
    { id: "before-1", driver_id: String(first[0].driver_id), driver_name: "x", event_date: "2026-09-15", start_ts: "2026-09-15T15:00:00.000Z", end_ts: "2026-09-15T17:00:00.000Z", duration_min: 120, status: "reviewed", superseded_at: null, run_id: "old-run" },
  );
  return { fenceIds, seeded };
}

describe("3. resumable sweep vs legacy single-shot sweep (parity)", () => {
  beforeEach(() => revive());

  it("produces identical events, superseded set and run totals", async () => {
    const { fenceIds, seeded } = await buildSeed();
    resetSweepDb(seedTables(fenceIds, seeded));
    const legacyRes = await legacySweep();
    const legacyEvents = normEvents(sweepDb.tables.driver_warehouse_events);
    const legacyRun = normRun(sweepDb.tables.driver_warehouse_runs[0]);
    const legacyCache = cacheMultiset(sweepDb.tables.samsara_cache_rows);

    resetSweepDb(seedTables(fenceIds, seeded));
    const res = await newSweep();
    const events = normEvents(sweepDb.tables.driver_warehouse_events);
    const run = normRun(sweepDb.tables.driver_warehouse_runs[0]);

    expect(legacyRes.ok).toBe(true);
    expect(res.ok).toBe(true);
    expect(events).toEqual(legacyEvents);
    expect(run).toEqual(legacyRun);
    expect(cacheMultiset(sweepDb.tables.samsara_cache_rows)).toEqual(legacyCache);
    // the perturbed reviewed event was reopened; the stale + known ones retired; before-window untouched
    const byId = new Map(sweepDb.tables.driver_warehouse_events.map((e: any) => [e.id, e]));
    expect(byId.get("stale-1").superseded_at).not.toBeNull();
    expect(byId.get("known-1").superseded_at).not.toBeNull();
    expect(byId.get("before-1")).toMatchObject({ status: "reviewed", superseded_at: null, run_id: "old-run" });
    expect(res.reopened).toBe(legacyRes.reopened);
    expect(run.status).toBe("completed");
  }, 120_000);
});

describe("13. selected-week mode", () => {
  it("does not write events outside the week, and retires exactly what the legacy sweep retires", async () => {
    const { fenceIds, seeded } = await buildSeed(true);
    // An event in the Eastern-midnight edge hour before the Central week start: inside the window, outside the week.
    const edge = { id: "edge-1", driver_id: String((seeded[0] as any).driver_id), driver_name: "x", event_date: "2026-09-20", start_ts: "2026-09-21T04:10:00.000Z", end_ts: "2026-09-21T04:40:00.000Z", duration_min: 30, status: "new", superseded_at: null, run_id: "old-run" };
    resetSweepDb(seedTables(fenceIds, [...seeded, edge]));
    await legacySweep();
    const legacy = normEvents(sweepDb.tables.driver_warehouse_events);
    resetSweepDb(seedTables(fenceIds, [...seeded, edge]));
    await newSweep();
    const now = normEvents(sweepDb.tables.driver_warehouse_events);
    expect(now).toEqual(legacy);
    const written = sweepDb.tables.driver_warehouse_events.filter((e: any) => e.run_id === sweepDb.tables.driver_warehouse_runs[0].id);
    expect(written.every((e: any) => e.event_date >= "2026-09-21" && e.event_date <= "2026-09-27")).toBe(true);
  }, 60_000);
});

describe("4. kill injection: die after any database call, resume, same final state", () => {
  it("every kill point converges to the uninterrupted result with no duplicate rows", async () => {
    const { fenceIds, seeded } = await buildSeed(true);
    resetSweepDb(seedTables(fenceIds, seeded));
    await newSweep();
    const baseEvents = normEvents(sweepDb.tables.driver_warehouse_events);
    const baseCache = cacheMultiset(sweepDb.tables.samsara_cache_rows);
    const baseRun = normRun(sweepDb.tables.driver_warehouse_runs[0]);
    const totalCalls = sweepDb.calls;
    expect(totalCalls).toBeGreaterThan(50);

    const job = await import("@/lib/driver-time/sweep-job.server");
    let points = 0;
    for (let k = 1; k <= totalCalls; k++) {
      resetSweepDb(seedTables(fenceIds, seeded));
      killAfter(k);
      let killed = false;
      try {
        await newSweep();
      } catch (e) {
        if (!(e instanceof KilledError)) throw e;
        killed = true;
      }
      revive();
      if (!killed) continue;
      points++;
      // Restart: the dead worker's lease expires; if it died before the run row existed, enqueue again.
      for (const r of sweepDb.tables.driver_warehouse_runs ?? []) r.lease_until = null;
      if (!(sweepDb.tables.driver_warehouse_runs ?? []).length) await job.enqueueDriverTimeSweep({ weekStart: WEEK });
      for (let i = 0; i < 5000; i++) {
        const t = await job.runDriverTimeTick({ budgetMs: Number.POSITIVE_INFINITY, maxUnits: 1 });
        if (!t.runId || t.status !== "running") break;
      }
      const runs = sweepDb.tables.driver_warehouse_runs;
      expect(runs.length, `kill at call ${k}`).toBe(1);
      expect(normRun(runs[0]), `kill at call ${k}`).toEqual(baseRun);
      expect(normEvents(sweepDb.tables.driver_warehouse_events), `kill at call ${k}`).toEqual(baseEvents);
      expect(cacheMultiset(sweepDb.tables.samsara_cache_rows), `kill at call ${k}`).toEqual(baseCache);
    }
    expect(points).toBe(totalCalls);
    console.info(`kill-injection: ${points} kill points over ${totalCalls} database calls`);
  }, 600_000);
});

