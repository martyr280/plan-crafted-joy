
ALTER TABLE public.inbound_emails
  ADD COLUMN IF NOT EXISTS referenced_order_id text,
  ADD COLUMN IF NOT EXISTS change_type text,
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS inbound_emails_referenced_order_idx
  ON public.inbound_emails(referenced_order_id)
  WHERE referenced_order_id IS NOT NULL;

-- order_change_requests
CREATE TABLE public.order_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid,
  p21_order_id text,
  inbound_email_id uuid,
  change_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  notes text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_change_requests TO authenticated;
GRANT ALL ON public.order_change_requests TO service_role;

ALTER TABLE public.order_change_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "order change ops"
  ON public.order_change_requests
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'ops_orders'::app_role) OR has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'ops_orders'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX order_change_requests_order_id_idx ON public.order_change_requests(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX order_change_requests_p21_order_id_idx ON public.order_change_requests(p21_order_id) WHERE p21_order_id IS NOT NULL;
CREATE INDEX order_change_requests_status_idx ON public.order_change_requests(status);

-- rma_requests
CREATE TABLE public.rma_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_id uuid,
  customer_name text,
  customer_id text,
  original_invoice text,
  original_order_id text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  status text NOT NULL DEFAULT 'open',
  notes text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rma_requests TO authenticated;
GRANT ALL ON public.rma_requests TO service_role;

ALTER TABLE public.rma_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rma ops"
  ON public.rma_requests
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'ops_orders'::app_role) OR has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'ops_orders'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX rma_requests_status_idx ON public.rma_requests(status);

-- quote_requests
CREATE TABLE public.quote_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_email_id uuid,
  customer_name text,
  customer_id text,
  subject text,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  status text NOT NULL DEFAULT 'open',
  assigned_to uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quote_requests TO authenticated;
GRANT ALL ON public.quote_requests TO service_role;

ALTER TABLE public.quote_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quote ops"
  ON public.quote_requests
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'ops_orders'::app_role) OR has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'ops_orders'::app_role) OR has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX quote_requests_status_idx ON public.quote_requests(status);
