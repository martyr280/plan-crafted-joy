
CREATE TABLE public.website_crawls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  pages_crawled integer NOT NULL DEFAULT 0,
  skus_found integer NOT NULL DEFAULT 0,
  error text,
  triggered_by uuid,
  notes text
);

ALTER TABLE public.website_crawls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "website_crawls_read" ON public.website_crawls FOR SELECT TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'ops_orders'::app_role)
  OR has_role(auth.uid(), 'ops_logistics'::app_role)
  OR has_role(auth.uid(), 'ops_ar'::app_role)
);

CREATE POLICY "website_crawls_admin_write" ON public.website_crawls FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TABLE public.website_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  family text,
  name text,
  description text,
  image_url text,
  detail_url text,
  brand text,
  category text,
  in_stock boolean,
  stock_text text,
  crawl_id uuid,
  crawled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_website_items_sku ON public.website_items (sku);
CREATE INDEX idx_website_items_crawl ON public.website_items (crawl_id);

ALTER TABLE public.website_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "website_items_read" ON public.website_items FOR SELECT TO authenticated
USING (true);

CREATE POLICY "website_items_admin_write" ON public.website_items FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
