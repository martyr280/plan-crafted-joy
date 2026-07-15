
ALTER TABLE public.truck_capacity_routes ADD COLUMN IF NOT EXISTS p21_cities text[];

-- Georgia: shared code GEO02 splits by weekday.
-- typical_dow uses JS getUTCDay numbering (Sun=0..Sat=6); Mon=1, Thu=4.
UPDATE public.truck_capacity_routes
   SET p21_route_code = 'GEO01,GEO02', typical_dow = ARRAY[1]::int[]
 WHERE code = 'SGA';
UPDATE public.truck_capacity_routes
   SET p21_route_code = 'GEO03,GEO02', typical_dow = ARRAY[4]::int[]
 WHERE code = 'NGA';

-- Carolinas: shared code NSC01, split by ship-to city.
UPDATE public.truck_capacity_routes
   SET p21_route_code = 'NSC01',
       p21_cities = ARRAY['Southern Pines','Dunn','Winterville','Wilson','Garner','Durham','Roxboro','Greensboro']
 WHERE code = 'ECAR';
UPDATE public.truck_capacity_routes
   SET p21_route_code = 'NSC01',
       p21_cities = ARRAY['Columbia','Charlotte','Troutman','Statesville','North Wilkesboro','Lenoir','Hudson','Gastonia','Greenville','Belton']
 WHERE code = 'WCAR';

-- Directional rename of the existing transfer lanes (codes unchanged).
UPDATE public.truck_capacity_routes SET name = 'Bham Transfer (Dallas → Birmingham)' WHERE code = 'BHM-XFER-DAL';
UPDATE public.truck_capacity_routes SET name = 'Dallas Transfer (Birmingham → Dallas)' WHERE code = 'DAL-XFER-BHM';

-- New Ocala-hub transfer lane: Ocala → Birmingham.
INSERT INTO public.truck_capacity_routes
  (code, name, hub, sort_order, active, has_vendor_pickup, truck_type, cutoff_time)
VALUES
  ('BHM-XFER-OCA', 'Bham Transfer (Ocala)', 'Ocala', 380, true, false, NULL,
   'CO Mon 10am CST // 11am EST')
ON CONFLICT (code) DO NOTHING;
