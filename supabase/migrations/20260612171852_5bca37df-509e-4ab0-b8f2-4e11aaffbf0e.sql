
CREATE TABLE public.spiff_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('salesrep_approver','ap')),
  label text NOT NULL,
  email text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spiff_contacts_kind_idx ON public.spiff_contacts(kind);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spiff_contacts TO authenticated;
GRANT ALL ON public.spiff_contacts TO service_role;
ALTER TABLE public.spiff_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff_contacts read" ON public.spiff_contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "spiff_contacts admin write" ON public.spiff_contacts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER spiff_contacts_touch BEFORE UPDATE ON public.spiff_contacts FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.spiff_automation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  day_of_month integer NOT NULL DEFAULT 5 CHECK (day_of_month BETWEEN 1 AND 28),
  send_hour integer NOT NULL DEFAULT 7 CHECK (send_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'America/Chicago',
  send_approvals boolean NOT NULL DEFAULT true,
  last_auto_quarter text,
  last_auto_run_at timestamptz,
  last_auto_status text,
  last_auto_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.spiff_automation TO authenticated;
GRANT ALL ON public.spiff_automation TO service_role;
ALTER TABLE public.spiff_automation ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff_automation read" ON public.spiff_automation FOR SELECT TO authenticated USING (true);
CREATE POLICY "spiff_automation admin write" ON public.spiff_automation FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER spiff_automation_touch BEFORE UPDATE ON public.spiff_automation FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.spiff_automation (enabled) VALUES (false);
