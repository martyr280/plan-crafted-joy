
ALTER TABLE public.catalogs
  ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS parsed_at timestamptz,
  ADD COLUMN IF NOT EXISTS parse_error text,
  ADD COLUMN IF NOT EXISTS sku_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id uuid NOT NULL REFERENCES public.catalogs(id) ON DELETE CASCADE,
  sku text NOT NULL,
  description text,
  list_price numeric,
  page integer,
  mfg text,
  raw text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (catalog_id, sku)
);

CREATE INDEX IF NOT EXISTS catalog_items_sku_idx ON public.catalog_items (sku);
CREATE INDEX IF NOT EXISTS catalog_items_catalog_idx ON public.catalog_items (catalog_id);

ALTER TABLE public.catalog_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY catalog_items_read ON public.catalog_items
  FOR SELECT TO authenticated USING (true);

CREATE POLICY catalog_items_admin_write ON public.catalog_items
  FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin'))
  WITH CHECK (has_role(auth.uid(),'admin'));
