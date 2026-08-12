-- helper predicate used across driver-time tables
CREATE OR REPLACE FUNCTION public.is_driver_time_viewer()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'admin')
      OR public.has_role(auth.uid(), 'ops_logistics')
      OR public.has_role(auth.uid(), 'ops_logistics_admin')
$$;

-- 1. runs -------------------------------------------------------------------
CREATE TABLE public.driver_warehouse_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start date NOT NULL,
  week_end date NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  drivers_scanned integer NOT NULL DEFAULT 0,
  events_found integer NOT NULL DEFAULT 0,
  error text,
  triggered_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.driver_warehouse_runs TO authenticated;
GRANT ALL ON public.driver_warehouse_runs TO service_role;
ALTER TABLE public.driver_warehouse_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_time viewers can read runs"
  ON public.driver_warehouse_runs FOR SELECT TO authenticated
  USING (public.is_driver_time_viewer());

CREATE TRIGGER driver_warehouse_runs_touch
  BEFORE UPDATE ON public.driver_warehouse_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2. events -----------------------------------------------------------------
CREATE TABLE public.driver_warehouse_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid REFERENCES public.driver_warehouse_runs(id) ON DELETE SET NULL,
  driver_id text NOT NULL,
  driver_name text,
  event_date date NOT NULL,
  start_ts timestamptz NOT NULL,
  end_ts timestamptz NOT NULL,
  duration_min integer NOT NULL,
  address_id text,
  address_name text,
  hub text,
  statuses text[] NOT NULL DEFAULT '{}',
  location_source text NOT NULL DEFAULT 'log',
  needs_review boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'new',
  notes text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, start_ts)
);

CREATE INDEX driver_warehouse_events_date_idx ON public.driver_warehouse_events (event_date DESC);
CREATE INDEX driver_warehouse_events_driver_idx ON public.driver_warehouse_events (driver_id, event_date DESC);

GRANT SELECT, INSERT, UPDATE ON public.driver_warehouse_events TO authenticated;
GRANT ALL ON public.driver_warehouse_events TO service_role;
ALTER TABLE public.driver_warehouse_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_time viewers can read events"
  ON public.driver_warehouse_events FOR SELECT TO authenticated
  USING (public.is_driver_time_viewer());
CREATE POLICY "driver_time viewers can update events"
  ON public.driver_warehouse_events FOR UPDATE TO authenticated
  USING (public.is_driver_time_viewer())
  WITH CHECK (public.is_driver_time_viewer());

CREATE TRIGGER driver_warehouse_events_touch
  BEFORE UPDATE ON public.driver_warehouse_events
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. pay rates (admin only) -------------------------------------------------
CREATE TABLE public.driver_pay_rates (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id text NOT NULL,
  driver_name text,
  hourly_rate numeric NOT NULL,
  effective_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, effective_date)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_pay_rates TO authenticated;
GRANT ALL ON public.driver_pay_rates TO service_role;
ALTER TABLE public.driver_pay_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage driver pay rates"
  ON public.driver_pay_rates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER driver_pay_rates_touch
  BEFORE UPDATE ON public.driver_pay_rates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. weekly Paycom overrides ------------------------------------------------
CREATE TABLE public.driver_time_week_overrides (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id text NOT NULL,
  week_start date NOT NULL,
  paycom_hours numeric,
  notes text,
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, week_start)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_time_week_overrides TO authenticated;
GRANT ALL ON public.driver_time_week_overrides TO service_role;
ALTER TABLE public.driver_time_week_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "driver_time viewers manage week overrides"
  ON public.driver_time_week_overrides FOR ALL TO authenticated
  USING (public.is_driver_time_viewer())
  WITH CHECK (public.is_driver_time_viewer());

CREATE TRIGGER driver_time_week_overrides_touch
  BEFORE UPDATE ON public.driver_time_week_overrides
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 5. default settings row ---------------------------------------------------
INSERT INTO public.app_settings (key, value)
VALUES ('driver_time', '{"warehouseAddressIds": [], "thresholdMinutes": 90, "excludedDriverIds": [], "excludedDriverNamePatterns": ["Birmingham LTL", "Birmingham Warehouse"], "mergeGapMinutes": 10, "hubTzByAddress": {}}'::jsonb)
ON CONFLICT (key) DO NOTHING;