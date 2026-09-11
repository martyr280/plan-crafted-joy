CREATE TABLE public.samsara_cache_days (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dataset text NOT NULL,
  day_date date NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  complete boolean NOT NULL DEFAULT false,
  row_count integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT samsara_cache_days_unique UNIQUE (dataset, day_date)
);

GRANT SELECT ON public.samsara_cache_days TO authenticated;
GRANT ALL ON public.samsara_cache_days TO service_role;

ALTER TABLE public.samsara_cache_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Driver time viewers can read cache days"
  ON public.samsara_cache_days FOR SELECT TO authenticated
  USING (public.is_driver_time_viewer());

CREATE TRIGGER samsara_cache_days_touch
  BEFORE UPDATE ON public.samsara_cache_days
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.samsara_cache_rows (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  day_id uuid NOT NULL REFERENCES public.samsara_cache_days(id) ON DELETE CASCADE,
  dataset text NOT NULL,
  day_date date NOT NULL,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  start_ts timestamptz,
  end_ts timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.samsara_cache_rows TO authenticated;
GRANT ALL ON public.samsara_cache_rows TO service_role;

ALTER TABLE public.samsara_cache_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Driver time viewers can read cache rows"
  ON public.samsara_cache_rows FOR SELECT TO authenticated
  USING (public.is_driver_time_viewer());

CREATE INDEX samsara_cache_rows_lookup
  ON public.samsara_cache_rows (dataset, day_date, entity_id);

CREATE INDEX samsara_cache_rows_day
  ON public.samsara_cache_rows (day_id);

CREATE INDEX samsara_cache_rows_time
  ON public.samsara_cache_rows (dataset, start_ts);