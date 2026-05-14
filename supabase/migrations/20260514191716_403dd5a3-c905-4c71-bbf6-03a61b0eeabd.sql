ALTER TABLE public.e2g_inventory_snapshot
  ADD COLUMN IF NOT EXISTS today timestamptz,
  ADD COLUMN IF NOT EXISTS next_due_in_2 text;