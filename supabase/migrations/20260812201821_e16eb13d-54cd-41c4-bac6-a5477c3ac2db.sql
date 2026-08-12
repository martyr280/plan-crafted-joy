CREATE TABLE public.route_cutoffs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  route_id uuid NOT NULL REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  p21_code text,
  cutoff_dow smallint NOT NULL CHECK (cutoff_dow BETWEEN 0 AND 6),
  cutoff_time time NOT NULL,
  tz text NOT NULL DEFAULT 'America/Chicago',
  run_dows smallint[] NOT NULL DEFAULT '{}',
  run_days_label text,
  driver_name text,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX route_cutoffs_route_idx ON public.route_cutoffs(route_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_cutoffs TO authenticated;
GRANT ALL ON public.route_cutoffs TO service_role;

ALTER TABLE public.route_cutoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view route cutoffs"
  ON public.route_cutoffs FOR SELECT TO authenticated USING (true);

CREATE POLICY "Logistics admins manage route cutoffs"
  ON public.route_cutoffs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin'));

CREATE TRIGGER route_cutoffs_touch
  BEFORE UPDATE ON public.route_cutoffs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

WITH seed(match_kind, match_code, cutoff_dow, cutoff_time, tz, run_dows, run_days_label, driver_name, notes, sort_order) AS (
  VALUES
    -- Birmingham (America/Chicago)
    ('p21','MSL01',2,'13:00','America/Chicago',ARRAY[3,4],'Runs Wed-Thu, back Fri',NULL,NULL,10),
    ('p21','SWM01',2,'13:00','America/Chicago',ARRAY[3],'Runs Wed',NULL,NULL,20),
    ('p21','NAL01',2,'13:00','America/Chicago',ARRAY[3],'Runs Wed',NULL,NULL,30),
    ('p21','NMS01',3,'13:00','America/Chicago',ARRAY[4],'Runs Thu',NULL,NULL,40),
    ('p21','CAL01',2,'13:00','America/Chicago',ARRAY[3],'Runs Wed',NULL,NULL,50),
    ('p21','CAL02',4,'12:00','America/Chicago',ARRAY[5],'Second run Fri',NULL,NULL,60),
    ('p21','MTN01',2,'16:00','America/Chicago',ARRAY[3,4],'Runs Wed-Thu',NULL,'Orders after Tue 4:00pm roll to the Thu 5:00pm cutoff',70),
    ('p21','MTN02',4,'17:00','America/Chicago',ARRAY[1,2],'Runs Mon-Tue (beginning of week)',NULL,'MTN02-only customers cannot ride MTN01',80),
    ('p21','ETN01',3,'10:00','America/Chicago',ARRAY[4],'Runs Thu',NULL,NULL,90),
    ('p21','WTN01',3,'10:00','America/Chicago',ARRAY[4],'Runs Thu',NULL,NULL,100),
    ('p21','GEO03',3,'13:00','America/Chicago',ARRAY[4],'North GA runs Thu',NULL,NULL,110),
    ('p21','GEO01',5,'13:00','America/Chicago',ARRAY[1],'South GA runs Mon','Josh',NULL,120),
    ('p21','NSC01',5,'13:00','America/Chicago',ARRAY[1],'Run CO Fri 1pm',NULL,'Worksheet note reads "Run CO Fri 1pm" - confirm run days with Joe',130),
    ('p21','GLF01',5,'13:00','America/Chicago',ARRAY[1],'Gulf Coast runs Mon',NULL,NULL,140),
    ('p21','OFL01',2,'17:00','America/Chicago',ARRAY[3],'Transfer/Dealer CO Tue 5pm',NULL,NULL,150),
    -- Dallas (America/Chicago)
    ('p21','DAL01',1,'15:00','America/Chicago',ARRAY[2],'Local: next-day delivery',NULL,'Dallas locals cut off daily at 3pm',200),
    ('p21','DAL01',2,'15:00','America/Chicago',ARRAY[3],'Local: next-day delivery',NULL,NULL,201),
    ('p21','DAL01',3,'15:00','America/Chicago',ARRAY[4],'Local: next-day delivery',NULL,NULL,202),
    ('p21','DAL01',4,'15:00','America/Chicago',ARRAY[5],'Local: next-day delivery',NULL,NULL,203),
    ('p21','DAL01',5,'15:00','America/Chicago',ARRAY[1],'Local: Fri orders deliver Mon',NULL,NULL,204),
    ('p21','MOAR1',1,'12:00','America/Chicago',ARRAY[2],'Next-day run Tue',NULL,NULL,210),
    ('p21','OKL01',4,'12:00','America/Chicago',ARRAY[5],'Runs Fri',NULL,NULL,220),
    ('p21','KAN01',4,'12:00','America/Chicago',ARRAY[5],'Runs Fri',NULL,NULL,230),
    ('p21','ARK01',5,'12:00','America/Chicago',ARRAY[1],'Runs Mon',NULL,NULL,240),
    ('p21','ARK02',5,'12:00','America/Chicago',ARRAY[1],'Runs Mon',NULL,NULL,250),
    ('p21','HOU01',5,'15:00','America/Chicago',ARRAY[1],'Big week (BW) runs Mon',NULL,'Worksheet: BW Fri CO 3pm - Joe reported both HOU cutoffs at Fri 3pm; confirm',260),
    ('p21','HOU02',3,'15:00','America/Chicago',ARRAY[4],'Every week (EW) runs Thu',NULL,'Worksheet: EW Wed CO 3pm - confirm with Joe',270),
    -- Transfer lanes have no P21 route code; matched on route code
    ('route','BHM-XFER-DAL',2,'16:00','America/Chicago',ARRAY[3],'CO Tue 4pm both ends',NULL,NULL,300),
    ('route','DAL-XFER-BHM',2,'16:00','America/Chicago',ARRAY[3],'CO Tue 4pm both ends',NULL,NULL,310),
    ('route','BHM-XFER-OCA',1,'10:00','America/Chicago',ARRAY[2],'Ocala to Bham: CO Mon 10am CST',NULL,NULL,320),
    -- Ocala (America/New_York)
    ('p21','JAX01',5,'13:00','America/New_York',ARRAY[1],'Mon run',NULL,NULL,400),
    ('p21','JAX02',2,'13:00','America/New_York',ARRAY[3],'Wed run',NULL,NULL,410),
    ('p21','SEFL1',5,'13:00','America/New_York',ARRAY[1],'Mon run',NULL,NULL,420),
    ('p21','SEFL1',3,'13:00','America/New_York',ARRAY[4],'Thu run',NULL,NULL,430),
    ('p21','MIA01',5,'13:00','America/New_York',ARRAY[1,2],'Mon/Tue runs',NULL,NULL,440),
    ('p21','MIA01',3,'13:00','America/New_York',ARRAY[4,5],'Thu/Fri runs',NULL,NULL,450),
    ('p21','ORL01',1,'13:00','America/New_York',ARRAY[2],'Tue run',NULL,NULL,460),
    ('p21','ORL02',3,'13:00','America/New_York',ARRAY[4],'Thu run',NULL,NULL,470),
    ('p21','SWFL1',1,'13:00','America/New_York',ARRAY[2],'Tue run',NULL,NULL,480),
    ('p21','SWFL1',4,'13:00','America/New_York',ARRAY[5],'Fri run',NULL,NULL,490),
    ('p21','TPA01',2,'13:00','America/New_York',ARRAY[3],'Wed run',NULL,NULL,500),
    ('p21','TPA01',4,'13:00','America/New_York',ARRAY[5],'Fri run',NULL,NULL,510),
    ('p21','SOCA1',5,'13:00','America/New_York',ARRAY[1],'Mon run',NULL,'LTL, 7 pallets or fewer',520)
),
resolved AS (
  SELECT s.*, r.id AS route_id
  FROM seed s
  LEFT JOIN public.truck_capacity_routes r
    ON (s.match_kind = 'p21'
        AND upper(s.match_code) = ANY (string_to_array(upper(replace(coalesce(r.p21_route_code, ''), ' ', '')), ',')))
    OR (s.match_kind = 'route' AND upper(s.match_code) = upper(r.code))
),
ins AS (
  INSERT INTO public.route_cutoffs
    (route_id, p21_code, cutoff_dow, cutoff_time, tz, run_dows, run_days_label, driver_name, notes, sort_order)
  SELECT route_id,
         CASE WHEN match_kind = 'p21' THEN match_code ELSE NULL END,
         cutoff_dow, cutoff_time::time, tz, run_dows::smallint[], run_days_label, driver_name, notes, sort_order
  FROM resolved
  WHERE route_id IS NOT NULL
  RETURNING 1
)
INSERT INTO public.activity_events (event_type, entity_type, message, metadata)
SELECT 'truck_capacity.cutoff_seed_unmatched',
       'route_cutoffs',
       'Route cutoff seed rows with no matching route: ' || string_agg(DISTINCT match_code, ', '),
       jsonb_build_object('unmatched_codes', jsonb_agg(DISTINCT match_code), 'inserted', (SELECT count(*) FROM ins))
FROM resolved
WHERE route_id IS NULL
HAVING count(*) > 0;