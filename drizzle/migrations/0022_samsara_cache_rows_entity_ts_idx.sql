CREATE INDEX IF NOT EXISTS samsara_cache_rows_dataset_entity_ts_idx
  ON public.samsara_cache_rows (dataset, entity_id, start_ts, id);