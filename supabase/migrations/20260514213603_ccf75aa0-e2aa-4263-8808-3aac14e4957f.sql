
-- 1. Extend price_list with family key + new published levels
ALTER TABLE public.price_list
  ADD COLUMN IF NOT EXISTS item_short TEXT,
  ADD COLUMN IF NOT EXISTS price_l1 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_l2 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_l3 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_l4 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_l5 NUMERIC;

CREATE INDEX IF NOT EXISTS price_list_item_short_idx ON public.price_list (item_short);

-- 2. Image cache (HEAD probe results for ndiofficefurniture.net)
CREATE TABLE IF NOT EXISTS public.sku_image_cache (
  full_sku TEXT PRIMARY KEY,
  image_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sku_image_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "image cache read" ON public.sku_image_cache
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "image cache admin" ON public.sku_image_cache
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 3. Manual family image overrides
CREATE TABLE IF NOT EXISTS public.sku_family_image_overrides (
  item_short TEXT PRIMARY KEY,
  image_path TEXT NOT NULL,
  uploaded_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sku_family_image_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "family overrides read" ON public.sku_family_image_overrides
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "family overrides admin" ON public.sku_family_image_overrides
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 4. Pricer PDF publication history
CREATE TABLE IF NOT EXISTS public.pricer_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  orientation TEXT NOT NULL,         -- 'landscape' | 'portrait'
  portrait_level TEXT,               -- 'list' | 'l1'..'l5'
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  pdf_path TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  generated_by UUID,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.pricer_publications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pricer pubs read" ON public.pricer_publications
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'ops_orders'::app_role)
    OR has_role(auth.uid(), 'ops_ar'::app_role)
    OR has_role(auth.uid(), 'sales_rep'::app_role)
  );
CREATE POLICY "pricer pubs admin" ON public.pricer_publications
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 5. Storage buckets
INSERT INTO storage.buckets (id, name, public)
  VALUES ('pricer-images', 'pricer-images', true)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public)
  VALUES ('pricer-pdfs', 'pricer-pdfs', false)
  ON CONFLICT (id) DO NOTHING;

-- pricer-images: public read, admin write
CREATE POLICY "pricer-images public read" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'pricer-images');
CREATE POLICY "pricer-images admin write" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'pricer-images' AND has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (bucket_id = 'pricer-images' AND has_role(auth.uid(), 'admin'::app_role));

-- pricer-pdfs: admin write, ops read
CREATE POLICY "pricer-pdfs ops read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'pricer-pdfs' AND (
      has_role(auth.uid(), 'admin'::app_role)
      OR has_role(auth.uid(), 'ops_orders'::app_role)
      OR has_role(auth.uid(), 'ops_ar'::app_role)
      OR has_role(auth.uid(), 'sales_rep'::app_role)
    )
  );
CREATE POLICY "pricer-pdfs admin write" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'pricer-pdfs' AND has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (bucket_id = 'pricer-pdfs' AND has_role(auth.uid(), 'admin'::app_role));
