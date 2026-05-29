CREATE TABLE public.sql_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  sql text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  action text NOT NULL DEFAULT 'email' CHECK (action IN ('email','upsert_price_list')),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  email_subject text,
  schedule_cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_row_count integer,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sql_schedules TO authenticated;
GRANT ALL ON public.sql_schedules TO service_role;

ALTER TABLE public.sql_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sql_schedules admin all"
ON public.sql_schedules FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER sql_schedules_touch
BEFORE UPDATE ON public.sql_schedules
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX sql_schedules_due_idx ON public.sql_schedules (next_run_at) WHERE active = true;