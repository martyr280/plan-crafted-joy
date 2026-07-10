
# Truck Capacity Module — Implementation Plan

Replaces NDI's "Primary Truck Capacity" workbook with a first-class module (capture, view, forecast, export). No code yet.

## 1. Reuse vs. new

- **`fleet_routes` already exists** with `hub`, `group_label`, `route_code`, `destination_city`, `delivery_day`, `driver_name`. **Reuse it** as the route dimension — add missing columns rather than a parallel `truck_capacity_routes` table. Avoids two sources of truth for hub/route lists that Logistics already reads.
- **`fleet_loads`** is a *per-shipment manifest* (truck_id, orders jsonb, weight, cube, capacity_pct). Overlapping intent but wrong grain: capacity workbook is one row per route per run-day (judgment %), not per truckload with order manifests. Keep separate; document the relationship (a `fleet_loads` row could later auto-populate a `truck_capacity_runs` row, out of scope for v1).
- **Reuse:** `ModuleHeader`, sql-schedules `runJob` + admin-editable SQL pattern, ExcelJS export pattern from `sql-schedules.server.ts`, TanStack Query + `*.functions.ts`/`*.server.ts` split, role gating via `assertAdmin`/`has_role`. **Do not reuse** `SifXmlImporter` — it's pipe-delimited SIF, wrong format; build a dedicated xlsx importer using `exceljs` server-side.

## 2. Database migrations

**Migration A — extend `fleet_routes`:**
- `active boolean default true`
- `sort_order int` (workbook tab order per hub)
- `has_vendor_pickup boolean default false` (MOAR, HOU, West TN L/S, N GA, S GA)
- `pallets_full_truck int` nullable (17–20 regional, ~10 local, ~6 FL box)
- `truck_type text` nullable ('53_trailer'|'box_truck'|'local')
- `typical_dow int[]` nullable

Seed/upsert the 35 routes from the spec, keyed by `route_code`.

**Migration B — new tables (all with GRANTs + RLS + `updated_at` trigger):**

```
truck_capacity_runs
  id uuid pk
  route_id uuid fk -> fleet_routes
  run_date date not null
  run_seq int not null default 1          -- for "Run 1/2/3" same-day
  capacity_frac numeric(4,3) not null     -- 0..1.25
  vendor_pickup_frac numeric(4,3) null
  driver text null
  pallet_count int null
  returned_pallets int null
  notes text null
  source text not null default 'manual'   -- manual|import|p21
  entered_by uuid null
  created_at, updated_at
  unique(route_id, run_date, run_seq)

truck_capacity_p21_demand      -- snapshot, not live
  id uuid pk
  route_id uuid fk
  ship_date date not null
  order_count int
  total_weight_lbs numeric
  total_cube_ft numeric
  est_pallets numeric
  projected_capacity_frac numeric(4,3)
  snapshot_at timestamptz not null default now()
  unique(route_id, ship_date, snapshot_at::date)

truck_capacity_settings        -- one row, admin-editable config (open questions a–d)
  id uuid pk
  capacity_basis text           -- 'pallets' | 'weight' | 'cube'
  vendor_pickup_counts boolean
  p21_sql text                  -- editable projection query
  updated_by, updated_at
```

RLS: authenticated read for `runs`/`demand`/`fleet_routes`; write on `runs` for ops_orders/admin; `settings` admin-only.

## 3. File plan

```
src/lib/truck-capacity.server.ts        forecast math, xlsx build, p21 snapshot, import parser
src/lib/truck-capacity.functions.ts     listRoutes, listRuns, upsertRun, deleteRun,
                                        importWorkbook, exportWorkbook, getForecast,
                                        runP21Snapshot, getSettings, updateSettings
src/routes/_app.truck-capacity.tsx      tabs: Overview | Route | Forecast | Import | Settings
src/components/truck-capacity/
  RouteSheetTable.tsx                   exact-workbook column table + edit dialog
  CapacityStackedBar.tsx                recharts stacked bar (Capacity + Unused = 1.0)
  HubOverviewGrid.tsx                   hub-grouped cards, sparkline, last-run, avg %
  UtilizationHeatmap.tsx                route × week heatmap
  ForecastChart.tsx                     stat forecast + MAD band + P21 overlay
  ForecastMathPopover.tsx               hover explanation
  WorkbookImportDialog.tsx              xlsx upload → dry-run diff → confirm
```

Sidebar: add "Truck Capacity" (icon `Truck`) under Fulfillment, next to Logistics.

## 4. Excel import (one-time seed)

Server function `importWorkbook({ fileBase64 })`:
- Parse with `exceljs`; iterate sheets, skip hidden Carolinas legacy sheet.
- Sheet → route via a hardcoded `SHEET_NAME_TO_ROUTE_CODE` map (35 entries) reviewed against seeded routes.
- Detect column indices by header text on row 1 (Date, Capacity, Unused Capacity, Vendor Pickup Capacity?, Driver, Pallet Count, Notes, Returned Pallets).
- Parse date cells: real Date → keep; string with " - Run N" suffix → strip, set `run_seq = N`; year < 2020 → skip and report; unparseable → skip and report.
- Coerce `capacity_frac` (clamp 0..1.25); ignore the `=1-B{n}` unused column (derived).
- Dry-run returns per-sheet counts (`ok`, `skipped_bad_date`, `skipped_no_capacity`, `duplicates`) before writing. Confirm → upsert with `source='import'` on the unique key.

## 5. P21 projection

- Store the projection SQL in `truck_capacity_settings.p21_sql` (admin-editable, same UX as sql-schedules). Do **not** hardcode column assumptions.
- Starter SQL commented with the joins we'd try (`oe_hdr` + `oe_line` + `inv_mast` weight/cube, filtered to open + ship_date within next 28 days, grouped by ship-to region → route). Explicit "unverified" comment for the client to correct.
- Nightly snapshot via a new `sql_schedules` cron entry OR a dedicated `/api/public/run-truck-capacity-snapshot` route wired to the same cron caller. Writes `truck_capacity_p21_demand`. Route → ship-to mapping lives in `fleet_routes` (add optional `ship_to_zip_prefixes text[]` if needed; flagged as an open question in Settings).

## 6. Forecast math (implemented exactly as spec)

`getForecast({ routeId, horizonDays=28 })` in `.server.ts`, pure function over runs:
1. Dominant weekdays: histogram of `EXTRACT(dow FROM run_date)` for last 84 days.
2. Baseline: trimmed mean (drop top/bottom 10%) of `capacity_frac` per (route, weekday) over last 56 days. Fallback route mean → hub mean when n<3.
3. Seasonal: `factor_m = mean(month_m) / mean(all)`, shrunk `(n*raw + 4*1.0)/(n+4)`.
4. `forecast = clamp(baseline * seasonal, 0, 1.25)`.
5. Band: ±MAD of trailing window.
6. Overlay: `final = max(forecast, p21_projection)` when demand row exists for that date.
7. Return per-day: `{ date, dow, baseline, seasonal, forecast, mad, p21, final, n_baseline, explain: "Thu baseline 0.72 (n=7) × Jul 0.94 = 0.68" }` — powers the hover.

## 7. Export

`exportWorkbook()` builds xlsx server-side with `exceljs` (reusing sql-schedules pattern): one sheet per active route in hub order, headers match workbook exactly, `Unused Capacity` written as literal formula `=1-B{row}`, Vendor Pickup column only on flagged routes. Skip charts.

## 8. UI details

- **Overview:** hub sections (Dallas, Birmingham, Ocala) → route cards showing sparkline (last 12 weeks), last run date/%, 8-wk avg, flags (≥90% red, ≤30% amber).
- **Route view:** route picker + date range + workbook-shape table + stacked bar chart. Inline edit + "Add run" button (multi-run same day supported).
- **Forecast:** 28-day chart with stat line + MAD band + P21 dots, tooltip renders `explain` string. Table below with per-day breakdown.
- **Settings tab (admin):** capacity_basis, vendor_pickup_counts, pallets_full_truck per route (editable grid), P21 SQL editor with "Test" button (runs against bridge, shows result), "Run snapshot now."
- **Import tab:** upload → dry-run → confirm.

## 9. Spec conflicts / notes

- Spec proposed `truck_capacity_routes`; **using existing `fleet_routes` instead** (one source of truth). Truck Capacity Settings page exposes the extra fields.
- Spec called for `fleet_routes` reuse "if better fit" — yes; `fleet_loads` stays untouched (different grain).
- Charts in export: skipping (exceljs chart support is thin); the app UI provides the charts.
- Live P21 queries on page load: rejected per spec; snapshot table only.
- Role gating: read = any authenticated user with `ops_orders` or above; write runs = `ops_orders`+; settings + import + P21 SQL edit = `admin`.

## 10. Open questions surfaced in UI (not hardcoded)

Rendered in Settings with defaults and inline explanations:
(a) capacity basis (pallets/weight/cube), (b) pallets_full_truck per route, (c) P21 route-assignment field (SQL editable), (d) vendor pickups counted in forecast — toggle.

## 11. Out of scope for v1

Auto-derivation of runs from `fleet_loads`; per-driver capacity attribution; SMS/email alerts on overcapacity days; multi-hub consolidation optimizer.
