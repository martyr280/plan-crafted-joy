# Agent rules
- Dispatch run dates come from src/lib/dispatch/assign.ts (date basis in truck_capacity_settings.dispatch_date_basis), never from vw_route_dispatch.ship_date — ship_date is NULL in the view.
- Dispatch date basis is pick_ticket_print (confirmed by Joe Green, NDI, 2026-09-29). Do not change the default.
