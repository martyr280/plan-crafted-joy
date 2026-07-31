CREATE TABLE public.sales_report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  period_year integer NOT NULL,
  period_month integer NOT NULL,
  triggered_by uuid REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'running',
  rep_count integer NOT NULL DEFAULT 0,
  error text,
  rep_status jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE public.sales_report_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.sales_report_runs(id) ON DELETE CASCADE,
  rep_code text NOT NULL,
  rep_name text,
  cust_code text NOT NULL,
  price_level text,
  bg text,
  customer_name text,
  city text,
  state text,
  total_value numeric,
  y2022 numeric,
  y2023 numeric,
  y2024 numeric,
  y2025 numeric,
  y_current numeric,
  ann_current numeric,
  pct numeric,
  month_sales numeric,
  month_profit numeric,
  keep_lvl_code text,
  keep_lvl_threshold numeric,
  keep_lvl_shortfall numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_srr_run_rep ON public.sales_report_rows (run_id, rep_code);
CREATE INDEX idx_srr_rep ON public.sales_report_rows (rep_code);
CREATE INDEX idx_srruns_run_at ON public.sales_report_runs (run_at DESC);

GRANT SELECT ON public.sales_report_runs TO authenticated;
GRANT ALL ON public.sales_report_runs TO service_role;
GRANT SELECT ON public.sales_report_rows TO authenticated;
GRANT ALL ON public.sales_report_rows TO service_role;

ALTER TABLE public.sales_report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_report_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales runs readable by staff" ON public.sales_report_runs
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR public.has_role(auth.uid(), 'sales_manager')
  OR public.has_role(auth.uid(), 'sales_rep')
);

CREATE POLICY "sales rows readable by managers" ON public.sales_report_rows
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR public.has_role(auth.uid(), 'sales_manager')
);

CREATE POLICY "sales rows readable by owning rep" ON public.sales_report_rows
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'sales_rep')
  AND rep_code = (SELECT p.sales_rep_code FROM public.profiles p WHERE p.id = auth.uid())
);