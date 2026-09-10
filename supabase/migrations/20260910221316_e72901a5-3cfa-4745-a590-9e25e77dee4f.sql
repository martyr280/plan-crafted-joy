-- 1. truck_capacity_runs: allow no-run markers, value history, and missing flag
ALTER TABLE public.truck_capacity_runs ALTER COLUMN capacity_frac DROP NOT NULL;
ALTER TABLE public.truck_capacity_runs ADD COLUMN IF NOT EXISTS prior_values jsonb;
ALTER TABLE public.truck_capacity_runs ADD COLUMN IF NOT EXISTS missing_from_sheet boolean NOT NULL DEFAULT false;

-- 2. Sheet -> route mapping (editable without a code change)
CREATE TABLE IF NOT EXISTS public.truck_capacity_sheet_map (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sheet_name text NOT NULL UNIQUE,
  route_id uuid REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.truck_capacity_sheet_map TO authenticated;
GRANT ALL ON public.truck_capacity_sheet_map TO service_role;
ALTER TABLE public.truck_capacity_sheet_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read sheet map" ON public.truck_capacity_sheet_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write sheet map" ON public.truck_capacity_sheet_map FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'ops_logistics_admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'ops_logistics_admin'::app_role));

-- 3. Sync state (singleton row)
CREATE TABLE IF NOT EXISTS public.truck_capacity_sync_state (
  id boolean NOT NULL DEFAULT true PRIMARY KEY CHECK (id),
  etag text,
  file_modified_at timestamptz,
  last_synced_at timestamptz,
  last_status text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.truck_capacity_sync_state TO authenticated;
GRANT ALL ON public.truck_capacity_sync_state TO service_role;
ALTER TABLE public.truck_capacity_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read sync state" ON public.truck_capacity_sync_state FOR SELECT TO authenticated USING (true);
INSERT INTO public.truck_capacity_sync_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 4. Sync log
CREATE TABLE IF NOT EXISTS public.truck_capacity_sync_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source text NOT NULL DEFAULT 'sharepoint',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  file_modified_at timestamptz,
  file_etag text,
  sheets_seen integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_updated integer NOT NULL DEFAULT 0,
  rows_skipped integer NOT NULL DEFAULT 0,
  rows_missing integer NOT NULL DEFAULT 0,
  unmatched_sheets jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tc_sync_log_started ON public.truck_capacity_sync_log (started_at DESC);
GRANT SELECT ON public.truck_capacity_sync_log TO authenticated;
GRANT ALL ON public.truck_capacity_sync_log TO service_role;
ALTER TABLE public.truck_capacity_sync_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read sync log" ON public.truck_capacity_sync_log FOR SELECT TO authenticated USING (true);

-- 5. Seed the sheet map from the verified workbook tab names (lowercased, whitespace-collapsed)
INSERT INTO public.truck_capacity_sheet_map (sheet_name, route_id, active, note)
SELECT s.sheet_name, r.id, true, s.note
FROM (VALUES
  ('dallas special runs','DAL-SPECIAL',NULL),
  ('dallas-local','DAL-LOCAL',NULL),
  ('dallas local','DAL-LOCAL',NULL),
  ('moar','MOAR',NULL),
  ('east tx','ETX',NULL),
  ('west tx','WTX',NULL),
  ('west texas','WTX',NULL),
  ('wtx','WTX',NULL),
  ('okl','OKL','header typo "Unused Capcity"'),
  ('hou','HOU',NULL),
  ('kan','KAN',NULL),
  ('ark','ARK',NULL),
  ('bham transfer','BHM-XFER-DAL',NULL),
  ('bham transfer (dallas)','BHM-XFER-DAL',NULL),
  ('birmingham transfer','BHM-XFER-DAL',NULL),
  ('birmingham special runs','BHM-SPECIAL',NULL),
  ('mislou','MISLOU',NULL),
  ('sw miss','SWMISS',NULL),
  ('north al','NAL',NULL),
  ('north miss.','NMISS',NULL),
  ('north miss','NMISS',NULL),
  ('central al','CAL',NULL),
  ('mid tn','MTN',NULL),
  ('east tn','ETN',NULL),
  ('west tn - long','WTN-LONG',NULL),
  ('west tn long','WTN-LONG',NULL),
  ('west tn - short','WTN-SHORT',NULL),
  ('west tn short','WTN-SHORT',NULL),
  ('dallas transfer','DAL-XFER-BHM',NULL),
  ('dallas transfer (bham)','DAL-XFER-BHM',NULL),
  ('dallas transfer(bham)','DAL-XFER-BHM',NULL),
  ('ocala transfer','OCA-XFER-BHM',NULL),
  ('ocala transfer (bham)','OCA-XFER-BHM',NULL),
  ('ocala transfer(bham)','OCA-XFER-BHM',NULL),
  ('ocala transfers','BHM-XFER-OCA','currently empty in the workbook'),
  ('ocala to bham','BHM-XFER-OCA',NULL),
  ('ocala to bham transfer','BHM-XFER-OCA',NULL),
  ('ocala to birmingham','BHM-XFER-OCA',NULL),
  ('ocala to birmingham transfer','BHM-XFER-OCA',NULL),
  ('bham transfer (ocala)','BHM-XFER-OCA',NULL),
  ('north ga','NGA',NULL),
  ('south ga','SGA',NULL),
  ('east carolina','ECAR',NULL),
  ('west carolina','WCAR',NULL),
  ('south al','SAL',NULL),
  ('gulf coast','GULF',NULL),
  ('ocala special runs','OCA-SPECIAL',NULL),
  ('jax','JAX',NULL),
  ('sefl','SEFL',NULL),
  ('mia','MIA',NULL),
  ('orl','ORL',NULL),
  ('swfl','SWFL',NULL),
  ('tampa','TAMPA',NULL)
) AS s(sheet_name, code, note)
JOIN public.truck_capacity_routes r ON r.code = s.code
ON CONFLICT (sheet_name) DO NOTHING;

-- Explicit skip: hidden legacy sheet with no matching route
INSERT INTO public.truck_capacity_sheet_map (sheet_name, route_id, active, note)
VALUES ('carolinas', NULL, false, 'hidden legacy sheet - explicit skip')
ON CONFLICT (sheet_name) DO NOTHING;