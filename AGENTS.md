# Agent rules
- Dispatch run dates come from src/lib/dispatch/assign.ts (date basis in truck_capacity_settings.dispatch_date_basis), never from vw_route_dispatch.ship_date — ship_date is NULL in the view.
