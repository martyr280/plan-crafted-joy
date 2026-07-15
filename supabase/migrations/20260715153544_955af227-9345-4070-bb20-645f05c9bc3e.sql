ALTER TABLE public.truck_capacity_routes
  ADD COLUMN IF NOT EXISTS p21_route_code text,
  ADD COLUMN IF NOT EXISTS cutoff_time text,
  ADD COLUMN IF NOT EXISTS cube_full_truck_ft3 numeric,
  ADD COLUMN IF NOT EXISTS weight_full_truck_lbs numeric;

UPDATE public.truck_capacity_routes
   SET p21_route_code = 'ETX01'
 WHERE upper(code) = 'ETX' AND p21_route_code IS NULL;