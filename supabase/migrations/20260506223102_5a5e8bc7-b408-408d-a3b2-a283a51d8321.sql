-- Inbound emails ingestion table
CREATE TABLE public.inbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id text,
  from_addr text NOT NULL,
  from_name text,
  to_addr text,
  subject text,
  body_text text,
  body_html text,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_payload jsonb,
  classification text NOT NULL DEFAULT 'unknown',
  confidence numeric,
  ai_summary text,
  ai_extracted jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'received',
  created_record_type text,
  created_record_id text,
  error text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX idx_inbound_emails_status ON public.inbound_emails(status, received_at DESC);
CREATE INDEX idx_inbound_emails_classification ON public.inbound_emails(classification);

ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inbound emails ops read" ON public.inbound_emails
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'ops_orders'::app_role)
    OR public.has_role(auth.uid(), 'ops_ar'::app_role)
    OR public.has_role(auth.uid(), 'ops_logistics'::app_role)
  );

CREATE POLICY "inbound emails ops update" ON public.inbound_emails
  FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'ops_orders'::app_role)
    OR public.has_role(auth.uid(), 'ops_ar'::app_role)
    OR public.has_role(auth.uid(), 'ops_logistics'::app_role)
  );

CREATE POLICY "inbound emails admin all" ON public.inbound_emails
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));