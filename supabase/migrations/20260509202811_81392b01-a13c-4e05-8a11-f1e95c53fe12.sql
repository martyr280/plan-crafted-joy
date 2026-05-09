
-- inventory_snapshots
CREATE TABLE public.inventory_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  item_desc text,
  birm_qty numeric DEFAULT 0,
  dallas_qty numeric DEFAULT 0,
  ocala_qty numeric DEFAULT 0,
  total_qty numeric DEFAULT 0,
  e2g_price numeric,
  weight numeric,
  net_weight numeric,
  next_due_in text,
  next_due_in_2 text,
  is_kit boolean DEFAULT false,
  snapshot_date timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual_xlsx',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_inv_snap_item ON public.inventory_snapshots(item_id);
CREATE INDEX idx_inv_snap_date ON public.inventory_snapshots(snapshot_date DESC);
ALTER TABLE public.inventory_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY inv_snap_read ON public.inventory_snapshots FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'ops_orders') OR has_role(auth.uid(),'ops_logistics') OR has_role(auth.uid(),'admin'));
CREATE POLICY inv_snap_admin_write ON public.inventory_snapshots FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- price_list
CREATE TABLE public.price_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item text NOT NULL,
  description text,
  mfg text,
  category text,
  cat_number text,
  list_price numeric,
  dealer_cost numeric,
  er_cost numeric,
  weight numeric,
  effective_date date,
  source text DEFAULT 'pricer_xlsx',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_price_list_item ON public.price_list(item);
ALTER TABLE public.price_list ENABLE ROW LEVEL SECURITY;
CREATE POLICY price_list_read ON public.price_list FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'ops_orders') OR has_role(auth.uid(),'ops_ar') OR has_role(auth.uid(),'ops_logistics') OR has_role(auth.uid(),'admin'));
CREATE POLICY price_list_admin_write ON public.price_list FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));
CREATE TRIGGER price_list_touch BEFORE UPDATE ON public.price_list FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- design_quotes
CREATE TABLE public.design_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_name text NOT NULL,
  source_file text,
  sif_date date,
  total_list numeric DEFAULT 0,
  total_sell numeric DEFAULT 0,
  room_count integer DEFAULT 0,
  line_count integer DEFAULT 0,
  imported_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.design_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY dq_ops ON public.design_quotes FOR ALL TO authenticated
  USING (has_role(auth.uid(),'ops_orders') OR has_role(auth.uid(),'admin'))
  WITH CHECK (has_role(auth.uid(),'ops_orders') OR has_role(auth.uid(),'admin'));

-- design_quote_lines
CREATE TABLE public.design_quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.design_quotes(id) ON DELETE CASCADE,
  line_no integer,
  part_number text,
  description text,
  quantity numeric DEFAULT 1,
  list_price numeric DEFAULT 0,
  room text,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dql_quote ON public.design_quote_lines(quote_id);
CREATE INDEX idx_dql_room ON public.design_quote_lines(room);
ALTER TABLE public.design_quote_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY dql_ops ON public.design_quote_lines FOR ALL TO authenticated
  USING (has_role(auth.uid(),'ops_orders') OR has_role(auth.uid(),'admin'))
  WITH CHECK (has_role(auth.uid(),'ops_orders') OR has_role(auth.uid(),'admin'));

-- catalogs
CREATE TABLE public.catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'catalog',
  file_path text NOT NULL,
  published_date date,
  pages integer,
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.catalogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalogs_read ON public.catalogs FOR SELECT TO authenticated USING (true);
CREATE POLICY catalogs_admin_write ON public.catalogs FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- storage bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('catalogs','catalogs',true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "catalogs public read" ON storage.objects FOR SELECT USING (bucket_id = 'catalogs');
CREATE POLICY "catalogs admin write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'catalogs' AND has_role(auth.uid(),'admin'));
CREATE POLICY "catalogs admin update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'catalogs' AND has_role(auth.uid(),'admin'));
CREATE POLICY "catalogs admin delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'catalogs' AND has_role(auth.uid(),'admin'));
