ALTER TABLE public.truck_capacity_settings
  ADD COLUMN IF NOT EXISTS excluded_p21_codes text[] NOT NULL DEFAULT ARRAY['WCALL','KCKS1']::text[];

UPDATE public.truck_capacity_settings
SET excluded_p21_codes = ARRAY['WCALL','KCKS1']::text[]
WHERE singleton = true
  AND (excluded_p21_codes IS NULL OR array_length(excluded_p21_codes, 1) IS NULL);

UPDATE public.truck_capacity_routes
SET cube_full_truck_ft3 = CASE WHEN truck_type = 'box_truck' THEN 1830 ELSE 4050 END
WHERE active = true;