ALTER TABLE public.driver_warehouse_runs
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS requested_week_start date,
  ADD COLUMN IF NOT EXISTS refresh_hos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drivers_total integer,
  ADD COLUMN IF NOT EXISTS days_fetched integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS steps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_step jsonb,
  ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN public.driver_warehouse_runs.status IS 'queued | running | completed | failed';