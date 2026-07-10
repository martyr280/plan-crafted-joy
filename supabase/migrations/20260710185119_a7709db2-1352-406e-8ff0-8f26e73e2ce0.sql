
CREATE TABLE public.truck_capacity_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trained_at timestamptz NOT NULL DEFAULT now(),
  coefficients jsonb NOT NULL,
  feature_names jsonb NOT NULL,
  lambda numeric NOT NULL,
  blend_w numeric NOT NULL,
  train_rows int NOT NULL,
  horizon_days int NOT NULL DEFAULT 28,
  holdout_mae_baseline numeric,
  holdout_mae_model numeric,
  holdout_mae_blend numeric,
  wape_baseline numeric,
  wape_model numeric,
  wape_blend numeric,
  per_route_mae jsonb,
  per_route_residual_mad jsonb,
  promoted boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.truck_capacity_model_versions TO authenticated;
GRANT ALL ON public.truck_capacity_model_versions TO service_role;
ALTER TABLE public.truck_capacity_model_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read model versions" ON public.truck_capacity_model_versions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write model versions" ON public.truck_capacity_model_versions
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE INDEX truck_capacity_model_versions_trained_at_idx
  ON public.truck_capacity_model_versions (trained_at DESC);
CREATE INDEX truck_capacity_model_versions_promoted_idx
  ON public.truck_capacity_model_versions (promoted, trained_at DESC) WHERE promoted;

CREATE TABLE public.truck_capacity_forecast_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  forecast_date date NOT NULL,
  made_on date NOT NULL,
  predicted numeric NOT NULL,
  method text NOT NULL,
  model_version_id uuid REFERENCES public.truck_capacity_model_versions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, forecast_date, made_on, method)
);
GRANT SELECT ON public.truck_capacity_forecast_log TO authenticated;
GRANT ALL ON public.truck_capacity_forecast_log TO service_role;
ALTER TABLE public.truck_capacity_forecast_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read forecast log" ON public.truck_capacity_forecast_log
  FOR SELECT TO authenticated USING (true);
CREATE INDEX truck_capacity_forecast_log_lookup_idx
  ON public.truck_capacity_forecast_log (route_id, forecast_date, made_on);
