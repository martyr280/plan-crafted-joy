ALTER TABLE public.price_list
  ADD COLUMN IF NOT EXISTS e2g_price numeric,
  ADD COLUMN IF NOT EXISTS e2g_weight numeric,
  ADD COLUMN IF NOT EXISTS in_e2g boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS e2g_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS price_list_item_norm_idx
  ON public.price_list (UPPER(REGEXP_REPLACE(item, '\s+', '', 'g')));