CREATE TABLE public.e2g_inventory_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  item_desc text,
  birm numeric,
  dallas numeric,
  ocala numeric,
  total numeric,
  e2g_price numeric,
  weight numeric,
  net_weight numeric,
  next_due_date date,
  next_due_in_display text,
  synced_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.e2g_inventory_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "e2g snapshot admin write"
  ON public.e2g_inventory_snapshot
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "e2g snapshot ops read"
  ON public.e2g_inventory_snapshot
  FOR SELECT
  TO authenticated
  USING (
    has_role(auth.uid(), 'admin'::app_role)
    OR has_role(auth.uid(), 'ops_orders'::app_role)
    OR has_role(auth.uid(), 'ops_logistics'::app_role)
  );

CREATE INDEX idx_e2g_snapshot_item_id ON public.e2g_inventory_snapshot(item_id);