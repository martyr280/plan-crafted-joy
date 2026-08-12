# Plan — Truck Capacity Forecast board + Driver Warehouse Time

Two independent features. Feature A ships first (single module, no new integration surface), Feature B second (new table set, new Samsara scopes, pay data). They do not share code, so B can be started in parallel by a second pass once A's migration is applied.

---

## FEATURE A — Forecast redesign: all routes at once

### What Joe gets

A landing board (default Forecast view) showing every active route at once, grouped by hub, one row per route:

```text
BIRMINGHAM
route            next cutoff        current  predicted  final  last actual   utilization bar
MSL01 Miss/La    Tue 1:00p (today)   0.42     0.71      0.71    0.68 (8/5)  [======|--- 90 ]
MTN01 Middle TN  Thu 5:00p (2d)      0.18     0.55      0.55    0.91 AT CAP [====      ]
```

- Rows for routes whose next cutoff is today or tomorrow sort to the top; then by hub sort order.
- Each row carries a plain-language label: "orders counted through Tue 1:00p cutoff" so a wrong cutoff mapping is visible, not silent.
- Weekend columns/rows appear only when a route actually has a Sat/Sun cutoff or `typical_dow` entry.
- Clicking a row opens the existing 28-day table + chart as a drill-down (route detail), unchanged in substance.
- Utilization is rendered as a horizontal bar 0–125% with reference marks at 30% and 90% and the existing flag colors/badges (>=90% at capacity, <=30% consolidate).
- Drill-down chart defaults to Final + P21 + uncertainty band; Baseline / Model / Blend move behind a toggle.

Alerting is untouched — this is display only.

### Cutoff model

New admin-editable table `route_cutoffs` (many per route). A route's "next cutoff" is the next occurrence of any of its cutoff rows in the route's timezone. Current capacity = open P21 demand for the run window that cutoff feeds.

Seeded from the Driver Routes worksheet as given (MSL01 Tue 1pm; MTN01 Tue 4pm + Thu 5pm; MTN02 Thu 4pm; HOU01/02 Fri 3pm; ARK01/02 Fri 12pm; OKL01/KAN01 Thu 12pm; MOAR1 Mon 12pm; DAL01 daily 3pm; GEO01/02 Fri 1pm; CAL01/02 Tue 1pm + Thu 12pm; NSC01 Fri 1pm; North GA Wed 1pm; GLF01 Fri 1pm; MIA01 Fri 12pm + Wed 12pm; ORL01/02 Mon 12pm + Wed 12pm; TPA01 Tue 12pm + Thu 12pm; JAX01/02 Fri 12pm + Tue 12pm; SEFL1 Fri 12pm + Wed 12pm; SOCA1 Fri 1pm EST; transfers Ocala→Bham Mon 10am, Bham→Ocala Thu 5pm, transfer/dealer Tue 5pm).

MTN01 and MTN02 stay separate route records — no merging.

The window logic (cutoff -> delivery days -> which open P21 ship dates count) is deliberately isolated in one pure module so it can be corrected iteratively without touching the board.

### Migration

```sql
CREATE TABLE public.route_cutoffs (
  id uuid pk default gen_random_uuid(),
  route_id uuid not null references public.truck_capacity_routes(id) on delete cascade,
  cutoff_dow smallint not null,          -- 0=Sun..6=Sat
  cutoff_time time not null,
  tz text not null default 'America/Chicago',
  run_days_label text,                   -- "runs Wed-Thu, back Fri"
  run_dows smallint[] not null default '{}',
  driver_name text,
  notes text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at/updated_at timestamptz
);
-- GRANT SELECT to authenticated; GRANT ALL to service_role
-- RLS: SELECT to authenticated; INSERT/UPDATE/DELETE via has_role(admin) OR has_role(ops_logistics_admin)
-- touch_updated_at trigger
-- literal INSERTs seeding the worksheet rows above, joined by truck_capacity_routes.p21_route_code / code
```

`truck_capacity_routes.cutoff_time` stays as a legacy display string (superseded, not dropped) to avoid breaking the current Settings card in the same change.

### Files

Create
- `src/lib/truck-capacity/cutoffs.ts` — pure: `nextCutoff(cutoffs, nowUtc)`, `cutoffWindow(cutoff)` -> `{ fromDate, toDate, label }`, DOW/tz math, weekend suppression.
- `src/lib/truck-capacity/__tests__/cutoffs.test.ts`
- `src/components/truck-capacity/ForecastBoard.tsx` — hub-grouped board + utilization bars.
- `src/components/truck-capacity/UtilizationBar.tsx`
- `src/components/truck-capacity/RouteCutoffsEditor.tsx` — Settings CRUD.

Modify
- `src/lib/truck-capacity.server.ts` — `computeForecastBoard()`: all active routes, join `route_cutoffs`, next cutoff, current (P21 in window), predicted/final from the existing serve path, last actual run.
- `src/lib/truck-capacity.functions.ts` — `getForecastBoard`, `listRouteCutoffs`, `upsertRouteCutoff`, `deleteRouteCutoff` (admin/ops_logistics_admin gated).
- `src/routes/_app.truck-capacity.tsx` — `ForecastTab` becomes board + drill-down state; simplify drill-down chart series; mount cutoffs editor in Settings tab.
- `src/hooks/` — new `useForecastBoard` hook (data fetching stays out of page components).

Reuse `computeForecastForRoute` per route rather than rewriting the model; batch it and cap concurrency so the board stays responsive (~31 routes).

### Tests
- `nextCutoff` across: multi-cutoff routes (MTN01 Tue+Thu), rollover past the last cutoff of the week, DST boundaries, EST vs CST routes, daily cutoffs (DAL01), weekend-free routes.
- `cutoffWindow` mapping to the right ship-date range for MTN01's two windows and for the Mon-run-after-Fri-cutoff cases (JAX01, SEFL1, MIA01).

---

## FEATURE B — Driver Warehouse Time (Samsara HOS)

### Architecture

```text
weekly cron gate in /api/public/run-sql-schedules
   -> runDriverTimeSweep (server)
        fetch /fleet/drivers (+ deactivated)   -> roster, minus exclusion list
        fetch /addresses                       -> geofences, minus non-warehouse
        fetch /fleet/hos/logs (batched driverIds, cursor paged, <=5 req/s)
   -> detect.ts (pure): ELD-day split -> non-driving blocks -> merge -> geofence match -> >=90min
   -> upsert driver_warehouse_events on (driver_id, start_ts)
   -> UI: _app.driver-time.tsx (weekly report, KPIs, review workflow, DOCX/CSV export)
```

8-day re-pull window each run, reconciling edited logs. No emails, no notification path — report surface with `new / reviewed / excused` statuses and notes, consistent with the house review-queue rule.

### Migrations

```sql
driver_warehouse_runs (id, week_start date, week_end date, status, started_at, completed_at,
  drivers_scanned int, events_found int, error text, triggered_by uuid)

driver_warehouse_events (id, run_id, driver_id text, driver_name text, event_date date,
  start_ts timestamptz, end_ts timestamptz, duration_min int, address_id text, address_name text,
  hub text, statuses text[], location_source text,        -- 'log' | 'vehicle_gps' | 'unknown'
  needs_review boolean, status text default 'new', notes text, reviewed_by uuid, reviewed_at,
  unique (driver_id, start_ts))

driver_pay_rates (id, driver_id text, driver_name text, hourly_rate numeric,
  effective_date date, unique (driver_id, effective_date))

driver_time_week_overrides (id, driver_id text, week_start date, paycom_hours numeric,
  unique (driver_id, week_start))
```

Settings live in `app_settings` under a `driver_time` key: `{ warehouseAddressIds, thresholdMinutes: 90, excludedDriverIds, mergeGapMinutes: 10, hubTzByAddress }` — no new settings table.

GRANTs: `SELECT/INSERT/UPDATE` to `authenticated` on events (RLS gated to admin / ops_logistics / ops_logistics_admin via `has_role`), `ALL` to `service_role`. Pay rates: admin-only read and write — this is compensation data.

### Detection rule (mirrors Joe's manual audit)

- Split each driver's segments on the ELD day boundary (`eldDayStartHour` from the driver record).
- Keep non-driving duty statuses: `onDuty` + `yardMove`. Merge consecutive kept segments; also merge across a gap of `< mergeGapMinutes` of movement when both sides sit in the same geofence.
- Locate a block by its recorded start location; if absent, fall back to the segment vehicle's GPS at that time; if still absent, emit the event with `location_source='unknown'` and `needs_review=true`.
- Point-in-circle (haversine vs `radiusMeters`) or point-in-polygon (ray casting) against selected warehouse addresses.
- Flag blocks `>= thresholdMinutes` (default 90). Multiple events per driver-day are expected and kept separate.
- Store UTC; render per-hub local (Dallas/Birmingham CST, Ocala EST).

### Cost estimate (labelled as an estimate)

Weekly Samsara on-duty hours per driver; if `>= 40` value flagged hours at `1.5 x rate`, else `1.0 x`. Paycom has no API, so each driver row exposes a paste field writing `driver_time_week_overrides.paycom_hours`, which takes precedence. The UI states plainly that OT is approximated.

### Files

Create
- `src/lib/samsara/hos.server.ts` — `fetchHosLogs`, `fetchDrivers`, `fetchAddresses`, rate-limited batch helper (token bucket ~4 req/s + retry/backoff on 429).
- `src/lib/driver-time/detect.ts` — pure block-merge + geofence + threshold engine.
- `src/lib/driver-time/geo.ts` — haversine, point-in-circle, point-in-polygon.
- `src/lib/driver-time/cost.ts` — OT estimate.
- `src/lib/driver-time/__tests__/detect.test.ts`, `geo.test.ts`, `cost.test.ts`
- `src/lib/driver-time.server.ts` — sweep runner, upsert/reconcile.
- `src/lib/driver-time.functions.ts` — `runDriverTimeSweep`, `getDriverTimeWeek`, `updateEventStatus`, `importPayRates`, `setPaycomHours`, `getDriverTimeSettings`, `saveDriverTimeSettings`, `listSamsaraAddresses`, `listSamsaraDrivers`.
- `src/lib/driver-time/docx.server.ts` — reprimand-format DOCX (reuse the existing `exceljs`-style export pattern; DOCX via a Workers-safe zip writer, print-friendly HTML as fallback).
- `src/routes/_app.driver-time.tsx` — weekly report, KPI cards, review workflow, exports, Settings card.
- `src/hooks/useDriverTime.ts`

Modify
- `src/lib/samsara.server.ts` — extend `samsaraHealthCheck` to probe HOS logs, drivers, addresses and report each missing scope explicitly.
- `src/lib/samsara.functions.ts` — expose the extended status.
- `src/routes/_app.settings.tsx` — Integrations card surfaces per-endpoint scope status with the remediation note that scopes are granted in the Samsara dashboard.
- `src/routes/api/public/run-sql-schedules.ts` — Monday UTC-gated weekly sweep block.
- `src/components/layout/AppSidebar.tsx` — "Driver Time" entry, role-gated.

---

## Sequencing

1. A migration (`route_cutoffs` + seed) -> `cutoffs.ts` + tests -> board server fn -> board UI -> Settings editor. Ship and let Joe correct cutoffs.
2. B migration -> HOS/addresses/drivers fetchers + health check -> detect engine + tests -> sweep runner -> UI -> exports -> cron gate.

## Open questions / risks

- Samsara token scopes: HOS logs, drivers and addresses may not be granted on the current token. The health check will name what is missing, but someone with Samsara admin access has to grant it before B produces data. Who?
- `route_cutoffs` seeding needs a code match between the worksheet's `p21_route_code` values (MSL01, MTN01, ...) and existing `truck_capacity_routes.code` (MISLOU, MTN, ...). I will match on `p21_route_code` first and report any worksheet row that finds no route rather than guessing.
- North GA and NSC01 ("Run CO Fri 1pm") are ambiguous in the notes — seeded as written, flagged in the editor for Joe to confirm.
- "Current capacity" fidelity depends on the nightly P21 demand snapshot; on days the snapshot failed the column will read stale. I will show the snapshot timestamp on the board rather than silently rendering old numbers.
- Cost estimates without Paycom are directional only. If the 300–400 flagged-hour figure is used in disciplinary conversations, the override field should be filled before anyone quotes a dollar number.
- Driver accounts that are not people ("Birmingham LTL", "Birmingham Warehouse") will produce large false positives until the exclusion list is populated; v1 seeds it with those two and any driver whose name matches a warehouse/dock pattern, all admin-editable.
