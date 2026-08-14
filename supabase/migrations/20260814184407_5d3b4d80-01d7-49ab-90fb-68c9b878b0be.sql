CREATE TABLE public.web_export_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trigger text NOT NULL DEFAULT 'manual',
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'running',
  database_name text,
  procedure_name text,
  remote_folder text,
  remote_filename text,
  row_count integer,
  byte_size integer,
  columns jsonb,
  preview jsonb,
  error text,
  job_id uuid,
  triggered_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX web_export_runs_started_idx ON public.web_export_runs (started_at DESC);

GRANT SELECT ON public.web_export_runs TO authenticated;
GRANT ALL ON public.web_export_runs TO service_role;

ALTER TABLE public.web_export_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and logistics admins can view website export runs"
ON public.web_export_runs FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE TRIGGER web_export_runs_touch
BEFORE UPDATE ON public.web_export_runs
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();