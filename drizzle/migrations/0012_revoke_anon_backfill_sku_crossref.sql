REVOKE EXECUTE ON FUNCTION public.backfill_sku_crossref_from_formerly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_sku_crossref_from_formerly() TO service_role;