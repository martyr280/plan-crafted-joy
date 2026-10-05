# Agent rules
- Dispatch run dates come from src/lib/dispatch/assign.ts (date basis in truck_capacity_settings.dispatch_date_basis), never from vw_route_dispatch.ship_date — ship_date is NULL in the view.
- Dispatch date basis is pick_ticket_print (confirmed by Joe Green, NDI, 2026-09-29). Do not change the default.
- Sales Reports rules live only in buildSalesReportSql + pure mirrors in src/lib/sales-annualized-template.ts (invoice lines, MIN order rep, row = rep+customer); one bridge job per run. Why: matches NDI's own rep files; one place to change.
- branch_manager (warehouse manager) is exclusive and read-only: scope = one active row in branch_manager_warehouses; every legacy *.functions.ts server fn uses denyLegacyBranchAccess (src/lib/branch-guard.ts); the only branch endpoint is branch-logistics.functions.ts; role/mapping/invite state change only through bm_* RPCs (service role). Why: fail-closed warehouse isolation enforced in DB + server, not UI.
- Branch-read forecasts call computeForecastForRoute(..., { logForecast: false }) — no forecast_log upsert, no activity_events insert. Why: viewing must not mutate.
