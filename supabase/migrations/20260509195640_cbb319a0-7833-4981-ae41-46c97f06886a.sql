
CREATE TABLE public.fleet_routes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  hub text NOT NULL,
  group_label text,
  route_code text,
  destination_city text NOT NULL,
  delivery_day text,
  driver_name text,
  schedule_notes text,
  raw_row jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fleet_routes_hub ON public.fleet_routes(hub);
CREATE INDEX idx_fleet_routes_route_code ON public.fleet_routes(route_code);
CREATE INDEX idx_fleet_routes_city ON public.fleet_routes(destination_city);

ALTER TABLE public.fleet_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fleet routes logistics"
ON public.fleet_routes FOR ALL TO authenticated
USING (has_role(auth.uid(), 'ops_logistics'::app_role) OR has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'ops_logistics'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER fleet_routes_updated_at
BEFORE UPDATE ON public.fleet_routes
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
