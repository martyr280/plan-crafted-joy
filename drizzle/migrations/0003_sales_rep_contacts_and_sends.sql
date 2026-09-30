CREATE TABLE public.sales_rep_contacts (
  rep_code text PRIMARY KEY,
  rep_name text,
  email text,
  cc_emails text[] NOT NULL DEFAULT '{}',
  send_enabled boolean NOT NULL DEFAULT true,
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_rep_contacts TO authenticated;
GRANT ALL ON public.sales_rep_contacts TO service_role;
ALTER TABLE public.sales_rep_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rep contacts readable by sales managers" ON public.sales_rep_contacts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'sales_manager'::app_role));
CREATE POLICY "rep contacts writable by admin" ON public.sales_rep_contacts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role)) WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));
CREATE TRIGGER sales_rep_contacts_touch BEFORE UPDATE ON public.sales_rep_contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.sales_report_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.sales_report_runs(id),
  rep_code text NOT NULL,
  to_email text,
  cc_emails text[] NOT NULL DEFAULT '{}',
  row_count int,
  attachment_name text,
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  skip_reason text,
  provider_message_id text,
  test_mode boolean NOT NULL DEFAULT false,
  sent_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_report_sends_run_rep_idx ON public.sales_report_sends (run_id, rep_code, created_at DESC);
GRANT SELECT, INSERT ON public.sales_report_sends TO authenticated;
GRANT ALL ON public.sales_report_sends TO service_role;
ALTER TABLE public.sales_report_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "report sends readable by sales managers" ON public.sales_report_sends FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'sales_manager'::app_role));
CREATE POLICY "report sends insertable by admin" ON public.sales_report_sends FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role));

-- Seed: every rep in the latest run; email only from P21 (read-only bridge probe 2026-09-30) or an app user's profile.
INSERT INTO public.sales_rep_contacts (rep_code, rep_name, email, send_enabled, notes)
SELECT r.rep_code, r.rep_name,
  COALESCE(p21.email, prof.email),
  CASE WHEN r.rep_code = '1015' THEN false ELSE true END,
  CASE WHEN r.rep_code = '1015' THEN 'from P21, unconfirmed. Send off: team account whose P21 email is a person (Travis Speier, who is also rep 5333)'
       WHEN p21.email IS NOT NULL THEN 'from P21, unconfirmed'
       WHEN prof.email IS NOT NULL THEN 'from app user' END
FROM (
  SELECT rep_code, max(rep_name) AS rep_name FROM public.sales_report_rows
  WHERE run_id = '6a6d2355-dd34-4371-ae04-37d0a4d038b1' GROUP BY rep_code
) r
LEFT JOIN (VALUES ('1016','jperry@ndiof.com'),('1015','tspeier@ndiof.com')) AS p21(rep_code,email) ON p21.rep_code = r.rep_code
LEFT JOIN LATERAL (SELECT email FROM public.profiles WHERE upper(trim(sales_rep_code)) = upper(r.rep_code) AND email IS NOT NULL LIMIT 1) prof ON true;