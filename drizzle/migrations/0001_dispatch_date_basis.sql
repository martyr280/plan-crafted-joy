ALTER TABLE public.truck_capacity_settings
  ADD COLUMN IF NOT EXISTS dispatch_date_basis text NOT NULL DEFAULT 'pick_ticket_print';
ALTER TABLE public.truck_capacity_settings
  ADD CONSTRAINT truck_capacity_settings_dispatch_date_basis_chk
  CHECK (dispatch_date_basis IN ('pick_ticket_print','earliest_required','requested','promise'));
COMMENT ON COLUMN public.truck_capacity_settings.dispatch_date_basis IS 'Which vw_route_dispatch date puts a pick ticket on a truck run. Pending Joe Green confirmation.';