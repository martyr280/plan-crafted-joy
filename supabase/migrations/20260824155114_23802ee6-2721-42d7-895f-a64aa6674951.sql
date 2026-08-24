CREATE TABLE public.samsara_address_map (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  p21_ship_to_id text NOT NULL UNIQUE,
  customer_id text,
  customer_name text,
  raw_addr1 text,
  raw_addr2 text,
  raw_city text,
  raw_state text,
  raw_zip text,
  samsara_address_id text,
  match_method text CHECK (match_method IN ('exact','fuzzy','geocoded','manual')),
  match_confidence numeric,
  verified boolean NOT NULL DEFAULT false,
  verified_by uuid,
  verified_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.route_stop_sequences (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route_id uuid NOT NULL REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  city_norm text NOT NULL,
  state text,
  position integer NOT NULL DEFAULT 0,
  delivery_dow_label text,
  is_pickup boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, city_norm, state)
);

CREATE INDEX route_stop_sequences_route_idx ON public.route_stop_sequences(route_id);

CREATE TABLE public.dispatch_driver_map (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route_id uuid NOT NULL UNIQUE REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  driver_name_raw text,
  samsara_driver_id text,
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.dispatch_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route_id uuid REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  route_code text,
  run_date date NOT NULL,
  run_seq integer NOT NULL DEFAULT 1,
  cutoff_at timestamptz,
  lock_at timestamptz,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','pushed','locked','completed','cancelled','error','needs_review')),
  samsara_route_id text,
  samsara_external_id text UNIQUE,
  stops_total integer,
  stops_held integer,
  orders_total integer,
  est_pallets numeric,
  est_cube_ft numeric,
  est_weight_lbs numeric,
  bridge_job_id uuid,
  pushed_payload jsonb,
  pushed_at timestamptz,
  pushed_by uuid,
  last_reconciled_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dispatch_runs_route_date_idx ON public.dispatch_runs(route_id, run_date DESC);

CREATE TABLE public.dispatch_stops (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dispatch_run_id uuid NOT NULL REFERENCES public.dispatch_runs(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  run_day date,
  pick_ticket_no text,
  order_no text,
  customer_id text,
  customer_name text,
  p21_ship_to_id text,
  samsara_address_id text,
  samsara_stop_id text,
  scheduled_arrival timestamptz,
  stop_notes text,
  est_pallets numeric,
  est_cube_ft numeric,
  est_weight_lbs numeric,
  hold boolean NOT NULL DEFAULT false,
  hold_reason text,
  state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_run_id, order_no, p21_ship_to_id)
);

CREATE INDEX dispatch_stops_run_idx ON public.dispatch_stops(dispatch_run_id, position);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.samsara_address_map TO authenticated;
GRANT ALL ON public.samsara_address_map TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_stop_sequences TO authenticated;
GRANT ALL ON public.route_stop_sequences TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_driver_map TO authenticated;
GRANT ALL ON public.dispatch_driver_map TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_runs TO authenticated;
GRANT ALL ON public.dispatch_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_stops TO authenticated;
GRANT ALL ON public.dispatch_stops TO service_role;

ALTER TABLE public.samsara_address_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_stop_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_driver_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_stops ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view address map"
  ON public.samsara_address_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "Logistics admins manage address map"
  ON public.samsara_address_map FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE POLICY "Authenticated can view stop sequences"
  ON public.route_stop_sequences FOR SELECT TO authenticated USING (true);
CREATE POLICY "Logistics admins manage stop sequences"
  ON public.route_stop_sequences FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE POLICY "Authenticated can view dispatch driver map"
  ON public.dispatch_driver_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "Logistics admins manage dispatch driver map"
  ON public.dispatch_driver_map FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE POLICY "Authenticated can view dispatch runs"
  ON public.dispatch_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Logistics admins manage dispatch runs"
  ON public.dispatch_runs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE POLICY "Authenticated can view dispatch stops"
  ON public.dispatch_stops FOR SELECT TO authenticated USING (true);
CREATE POLICY "Logistics admins manage dispatch stops"
  ON public.dispatch_stops FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE TRIGGER samsara_address_map_touch BEFORE UPDATE ON public.samsara_address_map
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER route_stop_sequences_touch BEFORE UPDATE ON public.route_stop_sequences
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER dispatch_driver_map_touch BEFORE UPDATE ON public.dispatch_driver_map
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER dispatch_runs_touch BEFORE UPDATE ON public.dispatch_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER dispatch_stops_touch BEFORE UPDATE ON public.dispatch_stops
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.app_settings (key, value)
VALUES ('dispatch', '{"enabledRouteIds": [], "depotDepartLocal": "07:00", "stopIncrementMin": 20, "lockOffset": "04:00", "geocoder": null, "viewName": "p21_analytics_play.dbo.vw_route_dispatch"}'::jsonb)
ON CONFLICT (key) DO NOTHING;