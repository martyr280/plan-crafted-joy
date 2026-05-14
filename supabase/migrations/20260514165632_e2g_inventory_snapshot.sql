-- E2G Combined Report snapshot.
-- Populated by the agent via the e2g.combined-report bridge job.
-- Replaced wholesale on each sync (P21 is source of truth; no row history).

CREATE TABLE public.e2g_inventory_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id text NOT NULL,
  item_desc text,
  birm text,
  dallas text,
  ocala text,
  total text,
  e2g_price text,
  weight text,
  net_weight text,
  next_due_date date,
  next_due_in_display text,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX e2g_inventory_snapshot_item_id_idx ON public.e2g_inventory_snapshot(item_id);
CREATE INDEX e2g_inventory_snapshot_synced_at_idx ON public.e2g_inventory_snapshot(synced_at);

ALTER TABLE public.e2g_inventory_snapshot ENABLE ROW LEVEL SECURITY;

CREATE POLICY "e2g reporters read"
  ON public.e2g_inventory_snapshot FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ops_reports'));
