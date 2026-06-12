
CREATE TABLE IF NOT EXISTS public.customer_price_levels (
  customer_id text PRIMARY KEY,
  customer_name text,
  price_level text NOT NULL,
  observed_count int NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.customer_price_levels TO authenticated;
GRANT ALL ON public.customer_price_levels TO service_role;

ALTER TABLE public.customer_price_levels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cpl read" ON public.customer_price_levels
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));

CREATE POLICY "cpl write" ON public.customer_price_levels
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));

CREATE TRIGGER customer_price_levels_touch
  BEFORE UPDATE ON public.customer_price_levels
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Backfill function: parse "Formerly #XYZ" out of price_list.description into sku_crossref.
CREATE OR REPLACE FUNCTION public.backfill_sku_crossref_from_formerly()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count int;
BEGIN
  WITH extracted AS (
    SELECT
      upper(regexp_replace((regexp_matches(description, 'Formerly[[:space:]]*#?([A-Z0-9-]+)', 'gi'))[1], '\s+', '', 'g')) AS legacy_sku,
      item AS ndi_sku
    FROM public.price_list
    WHERE description ~* 'Formerly[[:space:]]*#?[A-Z0-9-]+'
  ),
  ins AS (
    INSERT INTO public.sku_crossref (competitor_sku, ndi_sku, confidence, source)
    SELECT legacy_sku, ndi_sku, 0.95, 'price_list_formerly'
    FROM extracted
    WHERE legacy_sku IS NOT NULL AND length(legacy_sku) >= 3 AND legacy_sku <> ndi_sku
    ON CONFLICT (competitor_sku, ndi_sku) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM ins;
  RETURN inserted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.backfill_sku_crossref_from_formerly() TO authenticated, service_role;

SELECT public.backfill_sku_crossref_from_formerly();
