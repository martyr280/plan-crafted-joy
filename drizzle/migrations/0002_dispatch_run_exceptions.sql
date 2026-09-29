CREATE TABLE public.dispatch_run_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  p21_code text NOT NULL,
  run_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('no_run','reduced')),
  reason text NOT NULL CHECK (reason IN ('short_week','driver_pto','other')),
  note text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_run_exceptions_code_date_key UNIQUE (p21_code, run_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_run_exceptions TO authenticated;
GRANT ALL ON public.dispatch_run_exceptions TO service_role;
ALTER TABLE public.dispatch_run_exceptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read run exceptions" ON public.dispatch_run_exceptions FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin insert run exceptions" ON public.dispatch_run_exceptions FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "admin update run exceptions" ON public.dispatch_run_exceptions FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY "admin delete run exceptions" ON public.dispatch_run_exceptions FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));