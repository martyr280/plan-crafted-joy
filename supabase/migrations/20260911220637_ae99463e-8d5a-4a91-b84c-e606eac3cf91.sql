ALTER TABLE public.samsara_cache_days
  ADD COLUMN coverage jsonb NOT NULL DEFAULT '[]'::jsonb;