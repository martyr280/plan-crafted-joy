CREATE TABLE public.route_salespeople (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route_code text NOT NULL,
  rep_code text NOT NULL,
  rep_name text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_code, rep_code)
);

CREATE INDEX idx_route_salespeople_rep ON public.route_salespeople (rep_code) WHERE active;
CREATE INDEX idx_route_salespeople_route ON public.route_salespeople (route_code) WHERE active;

GRANT SELECT ON public.route_salespeople TO authenticated;
GRANT ALL ON public.route_salespeople TO service_role;

ALTER TABLE public.route_salespeople ENABLE ROW LEVEL SECURITY;

CREATE POLICY "route_salespeople readable by authenticated"
  ON public.route_salespeople FOR SELECT TO authenticated USING (true);

CREATE POLICY "route_salespeople managed by logistics admin"
  ON public.route_salespeople FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE TRIGGER route_salespeople_touch BEFORE UPDATE ON public.route_salespeople
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();