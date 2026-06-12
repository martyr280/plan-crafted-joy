
-- spiff_programs
CREATE TABLE public.spiff_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL,
  customer_name text NOT NULL,
  rep_org text NOT NULL,
  rate numeric NOT NULL,
  product_scope text NOT NULL DEFAULT 'all' CHECK (product_scope IN ('all','pl_ryker_jax','pl_ryker_jax_no_seating')),
  exclude_special_orders boolean NOT NULL DEFAULT false,
  payout_mode text NOT NULL CHECK (payout_mode IN ('per_writing_rep','single_check')),
  payee_name text,
  min_check_amount numeric NOT NULL DEFAULT 8,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spiff_programs_customer_id_uniq ON public.spiff_programs(customer_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spiff_programs TO authenticated;
GRANT ALL ON public.spiff_programs TO service_role;
ALTER TABLE public.spiff_programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff_programs read" ON public.spiff_programs FOR SELECT TO authenticated USING (true);
CREATE POLICY "spiff_programs admin write" ON public.spiff_programs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER spiff_programs_touch BEFORE UPDATE ON public.spiff_programs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- spiff_runs
CREATE TABLE public.spiff_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quarter_label text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','sent_to_ap')),
  created_by uuid REFERENCES auth.users(id),
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spiff_runs TO authenticated;
GRANT ALL ON public.spiff_runs TO service_role;
ALTER TABLE public.spiff_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff_runs read" ON public.spiff_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "spiff_runs admin write" ON public.spiff_runs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER spiff_runs_touch BEFORE UPDATE ON public.spiff_runs FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- spiff_run_lines
CREATE TABLE public.spiff_run_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.spiff_runs(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.spiff_programs(id) ON DELETE RESTRICT,
  customer_id text NOT NULL,
  order_date timestamptz,
  order_no text,
  po_no text,
  item_id text,
  item_desc text,
  qty_ordered numeric,
  unit_price numeric,
  extended_price numeric,
  product_group_id text,
  spiff_amount numeric NOT NULL DEFAULT 0,
  writing_rep text,
  rep_parse_confidence text NOT NULL DEFAULT 'parsed' CHECK (rep_parse_confidence IN ('parsed','unmatched','manual')),
  included boolean NOT NULL DEFAULT true,
  exclusion_reason text,
  flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spiff_run_lines_run_idx ON public.spiff_run_lines(run_id);
CREATE INDEX spiff_run_lines_program_idx ON public.spiff_run_lines(program_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spiff_run_lines TO authenticated;
GRANT ALL ON public.spiff_run_lines TO service_role;
ALTER TABLE public.spiff_run_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff_run_lines read" ON public.spiff_run_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "spiff_run_lines admin write" ON public.spiff_run_lines FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- spiff_checks
CREATE TABLE public.spiff_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.spiff_runs(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.spiff_programs(id) ON DELETE RESTRICT,
  customer_id text NOT NULL,
  payee text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  line_count integer NOT NULL DEFAULT 0,
  below_minimum boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','sent')),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spiff_checks_run_idx ON public.spiff_checks(run_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spiff_checks TO authenticated;
GRANT ALL ON public.spiff_checks TO service_role;
ALTER TABLE public.spiff_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff_checks read" ON public.spiff_checks FOR SELECT TO authenticated USING (true);
CREATE POLICY "spiff_checks admin write" ON public.spiff_checks FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER spiff_checks_touch BEFORE UPDATE ON public.spiff_checks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed 15 programs
INSERT INTO public.spiff_programs (customer_id, customer_name, rep_org, rate, product_scope, exclude_special_orders, payout_mode, payee_name, min_check_amount, notes) VALUES
('11440','OFFICE FURNITURE EXPO','IAI Joe Perry',0.04,'pl_ryker_jax',false,'per_writing_rep',NULL,8,NULL),
('11488','OFFICE FURNITURE SOLUTIONS','IAI Tamela Byrd',0.02,'pl_ryker_jax',true,'per_writing_rep',NULL,8,NULL),
('11459','OFFICE FURN & DESIGN CONCEPTS','IAI Tamela Byrd',0.02,'pl_ryker_jax_no_seating',true,'per_writing_rep',NULL,8,NULL),
('11460','OFFICE FURNITURE OUTFITTERS','Travis Speier',0.06,'all',false,'single_check','Owner — w/ rep breakdown',8,'6% rebate on entire account; 1 check to owner with breakdown of sales reps and their sales; L3 GOAL $1'),
('11086','INNOVATIVE BUSINESS FURNITURE','Solid Lines LLC',0.04,'pl_ryker_jax',false,'single_check','Innovative Business Furniture',8,NULL),
('11133','COMMERCIAL CONCEPTS','Solid Lines LLC',0.02,'pl_ryker_jax',false,'single_check','Jerry Kanoy',8,NULL),
('16665','WELTER STORAGE EQUIPMENT CO INC','Solid Lines LLC',0.04,'all',false,'per_writing_rep',NULL,8,NULL),
('10484','ATLANTA OFFICE LIQUIDATOR''S INC','IAI Pete Gebhardt',0.04,'all',false,'per_writing_rep',NULL,8,NULL),
('16506','DACOTAH PAPER dba SPENCER OFFICE','Solid Lines LLC',0.015,'all',false,'single_check','Ryan Sutter',8,'SS# on file'),
('17374','WORKSPACES INC dba BUSINESS FURNITURE WAREHOUSE','Solid Lines LLC',0.04,'all',false,'per_writing_rep',NULL,8,NULL),
('11826','USED OFFICE FURNITURE','Kenneth Williams',0.03,'all',false,'single_check','Ricky Seigler',8,NULL),
('14493','ANDERSON AND WORTH OFFICE FURNITURE','Kenneth Williams',0.03,'all',false,'per_writing_rep',NULL,8,NULL),
('11487','OFFICE RESOURCE GROUP','Kenneth Williams',0.03,'all',false,'single_check','Ross Lowe',8,NULL),
('11452','OFFICE FURNITURE TEAM','Kenneth Williams',0.03,'all',false,'per_writing_rep',NULL,8,NULL),
('10628','CARROLL''S DISCOUNT OFFICE','Donna Lange',0.03,'all',false,'per_writing_rep',NULL,8,NULL);
