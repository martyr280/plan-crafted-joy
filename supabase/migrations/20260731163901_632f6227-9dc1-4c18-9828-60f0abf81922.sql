CREATE TABLE public.rma_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rows_pulled integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  error text,
  sql_used text,
  triggered_by uuid REFERENCES auth.users(id),
  notes text
);

CREATE TABLE public.rma_snapshot_rows (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES public.rma_snapshots(id) ON DELETE CASCADE,
  rma_no text,
  rma_date date,
  customer_id text,
  customer_name text,
  order_no text,
  invoice_no text,
  item_id text,
  item_desc text,
  qty numeric,
  value numeric,
  reason_code text,
  reason_desc text,
  reason_bucket text NOT NULL DEFAULT 'other',
  route_code text,
  driver_name text,
  picker_name text,
  warehouse_id text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rma_snapshot_rows_snapshot_idx ON public.rma_snapshot_rows(snapshot_id);
CREATE INDEX rma_snapshot_rows_date_idx ON public.rma_snapshot_rows(rma_date DESC);
CREATE INDEX rma_snapshot_rows_order_idx ON public.rma_snapshot_rows(order_no);
CREATE INDEX rma_snapshot_rows_rma_idx ON public.rma_snapshot_rows(rma_no);
CREATE INDEX rma_snapshot_rows_bucket_idx ON public.rma_snapshot_rows(reason_bucket);

CREATE TABLE public.rma_entity_monthly (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  dimension_type text NOT NULL,
  dimension_key text NOT NULL,
  dimension_label text,
  month date NOT NULL,
  rma_count integer NOT NULL DEFAULT 0,
  rma_value numeric NOT NULL DEFAULT 0,
  rma_qty numeric NOT NULL DEFAULT 0,
  reason_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dimension_type, dimension_key, month)
);

CREATE INDEX rma_entity_monthly_dim_idx ON public.rma_entity_monthly(dimension_type, month DESC);

GRANT SELECT ON public.rma_snapshots TO authenticated;
GRANT ALL ON public.rma_snapshots TO service_role;
GRANT SELECT ON public.rma_snapshot_rows TO authenticated;
GRANT ALL ON public.rma_snapshot_rows TO service_role;
GRANT SELECT ON public.rma_entity_monthly TO authenticated;
GRANT ALL ON public.rma_entity_monthly TO service_role;

ALTER TABLE public.rma_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rma_snapshot_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rma_entity_monthly ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read rma snapshots"
  ON public.rma_snapshots FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read rma snapshot rows"
  ON public.rma_snapshot_rows FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can read rma entity monthly"
  ON public.rma_entity_monthly FOR SELECT TO authenticated USING (true);