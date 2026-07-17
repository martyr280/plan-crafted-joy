ALTER TABLE public.truck_capacity_settings
ADD COLUMN IF NOT EXISTS ignored_p21_route_codes text[] NOT NULL DEFAULT '{}';