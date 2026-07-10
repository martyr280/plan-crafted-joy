ALTER TABLE public.truck_capacity_forecast_log
  ADD COLUMN IF NOT EXISTS p21_guard_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS served numeric;