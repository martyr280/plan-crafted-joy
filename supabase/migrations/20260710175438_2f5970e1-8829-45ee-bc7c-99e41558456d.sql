
-- Truck Capacity module

-- 1. Routes dimension
CREATE TABLE public.truck_capacity_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  hub text NOT NULL CHECK (hub IN ('Dallas','Birmingham','Ocala')),
  sort_order int NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  has_vendor_pickup boolean NOT NULL DEFAULT false,
  truck_type text,
  pallets_full_truck int,
  typical_dow int[],
  ship_to_zip_prefixes text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.truck_capacity_routes TO authenticated;
GRANT ALL ON public.truck_capacity_routes TO service_role;
ALTER TABLE public.truck_capacity_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read routes" ON public.truck_capacity_routes FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write routes" ON public.truck_capacity_routes FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_tcr_updated BEFORE UPDATE ON public.truck_capacity_routes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2. Capacity runs (per route per day, possibly multiple runs)
CREATE TABLE public.truck_capacity_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  run_date date NOT NULL,
  run_seq int NOT NULL DEFAULT 1,
  capacity_frac numeric(4,3) NOT NULL,
  vendor_pickup_frac numeric(4,3),
  driver text,
  pallet_count int,
  returned_pallets int,
  notes text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','p21')),
  entered_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, run_date, run_seq)
);
CREATE INDEX idx_tcruns_route_date ON public.truck_capacity_runs (route_id, run_date DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.truck_capacity_runs TO authenticated;
GRANT ALL ON public.truck_capacity_runs TO service_role;
ALTER TABLE public.truck_capacity_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read runs" ON public.truck_capacity_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "ops write runs" ON public.truck_capacity_runs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_tcruns_updated BEFORE UPDATE ON public.truck_capacity_runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. P21 demand snapshot
CREATE TABLE public.truck_capacity_p21_demand (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  ship_date date NOT NULL,
  order_count int,
  total_weight_lbs numeric,
  total_cube_ft numeric,
  est_pallets numeric,
  projected_capacity_frac numeric(6,3),
  snapshot_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tcp21_route_ship ON public.truck_capacity_p21_demand (route_id, ship_date);
GRANT SELECT ON public.truck_capacity_p21_demand TO authenticated;
GRANT ALL ON public.truck_capacity_p21_demand TO service_role;
ALTER TABLE public.truck_capacity_p21_demand ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read demand" ON public.truck_capacity_p21_demand FOR SELECT TO authenticated USING (true);

-- 4. Settings (single-row config)
CREATE TABLE public.truck_capacity_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  capacity_basis text NOT NULL DEFAULT 'pallets' CHECK (capacity_basis IN ('pallets','weight','cube')),
  vendor_pickup_counts boolean NOT NULL DEFAULT false,
  p21_sql text,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.truck_capacity_settings TO authenticated;
GRANT ALL ON public.truck_capacity_settings TO service_role;
ALTER TABLE public.truck_capacity_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read settings" ON public.truck_capacity_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write settings" ON public.truck_capacity_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_tcs_updated BEFORE UPDATE ON public.truck_capacity_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.truck_capacity_settings (singleton, capacity_basis, vendor_pickup_counts)
VALUES (true, 'pallets', false);

-- 5. Seed 35 routes from workbook (order mirrors workbook tab order per hub)
INSERT INTO public.truck_capacity_routes (code, name, hub, sort_order, has_vendor_pickup, truck_type) VALUES
  -- Dallas hub
  ('DAL-SPECIAL','Dallas Special Runs','Dallas',10,false,'53_trailer'),
  ('DAL-LOCAL','Dallas-Local','Dallas',20,false,'local'),
  ('MOAR','MOAR','Dallas',30,true,'53_trailer'),
  ('ETX','East TX','Dallas',40,false,'53_trailer'),
  ('OKL','OKL','Dallas',50,false,'53_trailer'),
  ('HOU','HOU','Dallas',60,true,'53_trailer'),
  ('KAN','KAN','Dallas',70,false,'53_trailer'),
  ('ARK','ARK','Dallas',80,false,'53_trailer'),
  ('BHM-XFER-DAL','Bham Transfer (Dallas)','Dallas',90,false,'53_trailer'),
  -- Birmingham hub
  ('BHM-SPECIAL','Birmingham Special Runs','Birmingham',110,false,'53_trailer'),
  ('MISLOU','MisLou','Birmingham',120,false,'53_trailer'),
  ('SWMISS','SW Miss','Birmingham',130,false,'53_trailer'),
  ('NAL','North AL','Birmingham',140,false,'53_trailer'),
  ('NMISS','North Miss.','Birmingham',150,false,'53_trailer'),
  ('CAL','Central AL','Birmingham',160,false,'53_trailer'),
  ('MTN','Mid Tn','Birmingham',170,false,'53_trailer'),
  ('ETN','East Tn','Birmingham',180,false,'53_trailer'),
  ('WTN-LONG','West TN - Long','Birmingham',190,true,'53_trailer'),
  ('WTN-SHORT','West TN - Short','Birmingham',200,true,'53_trailer'),
  ('DAL-XFER-BHM','Dallas Transfer (Bham)','Birmingham',210,false,'53_trailer'),
  ('OCA-XFER-BHM','Ocala Transfer (Bham)','Birmingham',220,false,'53_trailer'),
  ('NGA','North GA','Birmingham',230,true,'53_trailer'),
  ('SGA','South GA','Birmingham',240,true,'53_trailer'),
  ('ECAR','East Carolina','Birmingham',250,false,'53_trailer'),
  ('WCAR','West Carolina','Birmingham',260,false,'53_trailer'),
  ('SAL','South AL','Birmingham',270,false,'53_trailer'),
  ('GULF','Gulf Coast','Birmingham',280,false,'53_trailer'),
  -- Ocala hub
  ('OCA-SPECIAL','Ocala Special Runs','Ocala',310,false,'53_trailer'),
  ('JAX','Jax','Ocala',320,false,'box_truck'),
  ('SEFL','SEFL','Ocala',330,false,'box_truck'),
  ('MIA','MIA','Ocala',340,false,'box_truck'),
  ('ORL','ORL','Ocala',350,false,'box_truck'),
  ('SWFL','SWFL','Ocala',360,false,'box_truck'),
  ('TAMPA','Tampa','Ocala',370,false,'box_truck');
