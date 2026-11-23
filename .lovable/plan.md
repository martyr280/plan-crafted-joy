Commit: Driver Time: resumable, chunked weekly sweep on its own tick (queued runs, heartbeat watchdog, safe staged cache writes, indexed GPS lookup)

What I think is wrong or missing in the brief:
- (a) Your worst-case risk has already happened. 8 GPS cache days are marked `complete=true` with only part of their rows: 09-22 (19,000 of 64,476), 09-29 (25,000/67,347), 10-13, 10-20, 10-26, 11-05, 11-09, 11-16 (I checked by comparing `row_count` with the real row count). The cause is that `writeCacheDay` upserts the day as complete and only then deletes and inserts the rows. Every later read treats those days as fresh. The 09-30 completed run, which produced the 32 reviewed events, very likely read the partial 09-22 GPS day. I won't change those events, but you should know.
- (b) "No deletes of samsara_cache_rows" conflicts with how the cache works today. Re-fetching any day (an in-progress day, or a refresh of HOS logs) deletes that day's rows and inserts them again. GPS can be filled append-only (see 4b), but HOS logs, daily logs and assignments of an in-progress day can't: a segment that is still open changes its end time. Decision for you: allow replacement only for the rows of a non-GPS day being re-fetched. Default in this plan: allowed, done in a staged, kill-safe way. If you say no, those days are never refreshed, and a run whose window includes an open day uses the copy from the first fetch.
- (c) The index should be `(dataset, entity_id, start_ts, id)`, not three columns. `start_ts` isn't unique (two vehicles' samples, or segments that share a start), so keyset paging needs `id` as the tiebreak.
- (d) The 20 s Samsara timeout is too long for a 15–20 s budget. A step that starts at 14.9 s plus a 20 s hang reaches 35 s, which is the kill point you saw. I use 12 s per request and stop starting new units after 15 s, so the worst case is about 27 s.
- (e) Freshness can't be re-checked when detection runs. An open day goes stale after 30 minutes, so a multi-tick Monday run would loop back to fetching. The fetch phase freezes the list of day ids in the cursor, and detection reads exactly those. Results match a single-shot run done at the moment fetching ended.
- (f) pg_cron with HTTP: the platform's guidance is to use managed callback auth (`cron_auth`), not hand-written `net.http_post` SQL. I'll try the managed route first. If it isn't available, I'll stop and ask you before using the job-3 anon-key pattern. That pattern also means anyone holding the public anon key can trigger a tick. That is harmless here: a tick only advances queued work, under a lease, and returns no data.
- (g) The retry-safety of the per-step counters (inserted/updated/reopened) is approximate. A step killed after its writes and then retried counts its inserts as updates. The event rows themselves end up identical.

## 1. Resumable, chunked sweep

New `src/lib/driver-time/sweep-job.server.ts`. Per run, phases are: `init -> fetch_hos -> fetch_assign -> plan_vehicles -> fetch_gps -> detect -> finalize -> completed`.

- **init**: compute the window (same code as today: `selectedWeekBounds`, Eastern and Central midnight, clamp to now, `scheduledSweepWeek` label). Load settings, `fetchDrivers` and `fetchAddresses`, run `filterRoster`, build the warehouses. Snapshot everything into the cursor: roster ids, known driver ids, warehouses, settings subset, window, week. A mid-run settings change can't mix two configurations. The existing "no warehouses" and "no drivers" messages fail the run exactly as today.
- **fetch_hos / fetch_assign**: one unit = one Central day for the whole roster (the existing `fetchHosLogs` / `fetchDriverVehicleAssignments`). A day is skipped if fresh, covering, and `row_count` equals the real count. Nothing stays in memory after the unit.
- **plan_vehicles**: per batch of 10 drivers, read that driver's cached hos and assignment rows by keyset. Compute `dominantVehiclePerDriverDay` and the backfilled vehicle ids (same functions). Add the vehicle ids to `cursor.vehicleIds`.
- **fetch_gps**: one unit = one day × 20 vehicles. That is one existing Samsara batch, about 1–3 s. It is the "split by vehicle" you asked for, applied always rather than only when a day doesn't fit. Coverage is merged when the last chunk of the day finishes.
- **detect**: one unit = one driver. Read that driver's hos and assignment rows, and the GPS of only that driver's vehicles, by keyset on the new index, filtered to the frozen day ids. Then backfill, run `detectWarehouseEvents` (unchanged inputs per driver), and reconcile that driver's events. `drivers_scanned` and `events_found` grow per step. Feeding only the driver's vehicles' GPS gives identical results: every GPS read in detect.ts filters by the segment's vehicle id (lines 228, 386). A test proves it.
- **finalize**: stale = events in the window (start > startMs, end < endMs) for scanned or known drivers, not superseded, and `run_id <> this run`. Every event this run wrote or updated carries `run_id = this run`, which is the old in-memory `seen` set, persisted. Events skipped by the weekStart filter are not stamped, exactly as `seen` excluded them before. Read with the shared pager, set `superseded_at` in batches of 200, then mark the run completed with the same totals and error text as today.
- **One run at a time**: the tick picks the oldest active run (`status in (queued, running)`, by `created_at`). It claims a lease with one conditional UPDATE (`lease_until is null or < now()`). A row that comes back empty means another tick holds it, so this tick exits.

## 2. Per-tick budget and endpoint

- New `src/routes/api/public/driver-time-tick.ts`, using the same secret/anon check as run-sql-schedules. It runs the watchdog, claims the run, and loops units while less than 15 s has elapsed. It renews the lease and heartbeat after every unit, then returns a JSON summary.
- In `run-sql-schedules.ts`: the Monday 08:00–08:15 Central block now only enqueues (a queued row) behind the same "already swept today" guard. The inline `runDriverTimeSweep` call is removed. The watchdog call stays there too (cheap), and nothing else in that file changes. Job 3 is untouched.
- New cron job every minute: 1,440 calls a day. An idle tick is one small indexed SELECT on a table with about 20 rows. It's always on because a manual "Run now" can happen at any time.

## 3. Samsara timeout

`api()` in `hos.server.ts`: AbortController with a 12 s timeout (see d). An abort is an error, so the unit fails and is retried next tick. The 4 req/s throttle and 429 backoff are unchanged.

## 4. Detection speed with identical results

- `src/lib/driver-time/gps-index.ts`: `buildGpsIndex(samples)` builds a per-vehicle array of usable samples, sorted by `(timeMs, original array position)`. `nearestSample(idx, vehicleId, t, tol)` binary-searches the insertion point and walks outward on both sides while `|dt| <= tol`. It keeps the minimum delta, and on equal delta the lowest original position. That is the sample the linear loop keeps today with strict `<`, whether it comes earlier in the array or earlier in time. I match the array order exactly rather than "earlier in time", because that is what today's code actually does.
- `resolveLocation`: its block can name a set of vehicles, but it only proceeds when the set has exactly one vehicle, so it becomes a single lookup. `locateSegment` becomes a single lookup. The index is built once per `detectWarehouseEvents` call. No other detect.ts change.
- 4b. GPS writes are append-only: for each chunk, read the existing `(entity_id, start_ts, lat, lon)` for those vehicles and that day, and insert only the missing samples. This repairs the 8 partial days without deleting anything.

## 5. Watchdog

`failStaleDriverTimeRuns` fails `running` runs where `coalesce(heartbeat_at, started_at) < now - 15 min`. Error: `Stalled: no progress for 15 minutes at phase <phase>, cursor <day/chunk/driver n of N>, last step <last_step.at>`. Old failed rows aren't touched.

A unit that fails 5 ticks in a row fails the run with the unit's last error.

## 6. Manual Run now and UI

- `runDriverTimeSweepNow({weekStart?})` validates `weekStart` as today, then inserts a queued row and returns `{ ok, runId, queued: true }` at once. If an active run already exists for the same requested week, it returns that run's id instead.
- `useDriverTime` / `_app.driver-time.tsx`: the run list shows queued or running, the phase, and "drivers N of M" or "GPS day d, chunk c". The query refreshes every 5 s while any run is active. Week semantics are unchanged.

## 7. Step logging

After every unit: `last_step` (phase, unit, rows fetched/inserted, ms, error), `steps += 1`, the counters, and the last 50 steps in `step_log`.

## Kill-safety per step

- **Cache day (non-GPS)**:
  1. Upsert the day with `complete=false`, `coverage=[]`.
  2. Delete its rows (only if (b) is approved).
  3. Insert in chunks of 500.
  4. Update `complete`, `coverage`, `row_count`, `fetched_at`.

  A kill before step 4 leaves the day stale (it doesn't cover any entities), so it is re-fetched. It is never read as complete.
- **GPS chunk**: inserts are append-only after a difference check, so a retry inserts only what is still missing. The day's coverage and completion are set only after its last chunk and a recount. A kill at any line leaves at worst extra-safe stale state.
- **plan_vehicles / detect cursor**: the cursor advances only after the unit's writes return, in the same UPDATE as the heartbeat. A kill repeats the unit.
- **Event reconcile (per driver)**: inserts are protected by the unique `(driver_id, start_ts)` key. On retry, the existing rows are re-read, so an event that was already inserted takes the update path. A reopen that was already applied is seen as "timing unchanged", which gives the same final row. Nothing is retired until finalize.
- **finalize**: the stale set is re-derived from the database every attempt (`run_id <> this run`). `superseded_at` batches are idempotent. Status is set to completed last, so a kill reruns finalize.
- **Lease**: lasts 90 s, so a killed tick blocks others for at most 90 s and two ticks never advance the same run.

## Migrations

`0022_driver_time_resumable_sweep.sql` (no new status constraint, because `status` is plain text):
```sql
ALTER TABLE public.driver_warehouse_runs
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS requested_week_start date,
  ADD COLUMN IF NOT EXISTS refresh_hos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drivers_total integer,
  ADD COLUMN IF NOT EXISTS days_fetched integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS steps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_step jsonb,
  ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN public.driver_warehouse_runs.status IS 'queued | running | completed | failed';
```

`0023_samsara_cache_rows_entity_ts_idx.sql`:
```sql
CREATE INDEX IF NOT EXISTS samsara_cache_rows_dataset_entity_ts_idx
  ON public.samsara_cache_rows (dataset, entity_id, start_ts, id);
```
This can't be built without locking inside the migration transaction. It blocks writes to `samsara_cache_rows` while it builds (estimated tens of seconds on 1.77M rows). Nothing else writes there except the sweep, which is dead today.

Cron job (via the managed scheduler, see f). The intended equivalent in the job-3 shape:
```sql
SELECT cron.schedule('driver-time-tick', '* * * * *', $$
  SELECT net.http_post(
    url := 'https://project--8f98c139-aabe-4588-ba0d-f1c274f9fea8.lovable.app/api/public/driver-time-tick',
    headers := '<same headers jsonb as job 3>'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
```

## Files

- New: `src/lib/driver-time/sweep-job.server.ts`, `src/lib/driver-time/gps-index.ts`, `src/routes/api/public/driver-time-tick.ts`, and the 2 migrations.
- Changed:
  - `src/lib/driver-time.server.ts`: watchdog, plus enqueue helper. `runDriverTimeSweep` is kept as a thin wrapper that runs units to completion, for tests only.
  - `src/lib/driver-time/detect.ts`: the GPS lookup only.
  - `src/lib/samsara/cache.server.ts`: staged writes, append GPS, keyset readers.
  - `src/lib/samsara/hos.server.ts`: timeout.
  - `src/routes/api/public/run-sql-schedules.ts`: enqueue only.
  - `src/lib/driver-time.functions.ts`, `src/hooks/useDriverTime.ts`, `src/routes/_app.driver-time.tsx`.
  - `AGENTS.md` (one rule), `roadmap.md`.

## Tests

1. GPS index vs the old linear version (both kept in the test) over all 7 fixtures plus random cases with ties: identical `WarehouseEvent[]`.
2. Per-driver GPS subset vs the full GPS array: identical events.
3. Resumable run vs the old single-shot sweep on the weekly-db fake: identical events, superseded set and run totals.
4. Kill injection: throw after every database call in each phase, resume, and get the same final state with no duplicate rows.
5. Staged cache write killed between delete and insert: the day is not served as fresh.
6. GPS append-only: a partial day gets filled to the full count, and a retry inserts 0.
7. The lease: two concurrent ticks, one advances.
8. Oldest queued run first.
9. Watchdog uses the heartbeat, not the start time, and the message names the phase and cursor.
10. Samsara abort after 12 s: the throttle and 429 retry are still intact.
11. The run-sql-schedules Monday block enqueues only and the dedup holds. No `runDriverTimeSweep` import there.
12. Run now returns the run id without running units, and a duplicate week returns the existing id.
13. weekStart mode: events outside the week are not written and not retired.
14. UI: a queued or running run shows progress and refreshes.
15. Wiring: keyset reads don't use `.range` offset.

Then the full suite and the typecheck.

## Backfill (planned, not run)

1. Check first with a SELECT: `select count(*) from driver_warehouse_events where reviewed_at is not null and start_ts >= '2026-09-28T04:00:00Z'` should return 0. The earliest window starts at the Eastern midnight of 09-28 (04:00Z). Reconcile only reads events with `start_ts >=` the window start, and retirement only touches events that start after it. All 32 reviewed events are dated 09-25 or earlier, so none can be read, reopened or retired.
2. Queue the runs with one insert. `init` fills in the windows; the timestamps are staggered so the runs go oldest first:
```sql
INSERT INTO public.driver_warehouse_runs (week_start, week_end, requested_week_start, status, phase, created_at, started_at)
SELECT w::date, w::date + 6, w::date, 'queued', 'init', now() + (n || ' ms')::interval, now() + (n || ' ms')::interval
FROM unnest(array['2026-09-28','2026-10-05','2026-10-12','2026-10-19','2026-10-26','2026-11-02','2026-11-09','2026-11-16']) WITH ORDINALITY AS t(w, n);
```
Alternatively, pick each week in Driver Time and press Run now: same result, one row each. The partial GPS days in these weeks get repaired by 4b during the fetch phase.
