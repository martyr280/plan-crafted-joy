
-- ============ ROLES ============
CREATE TYPE public.app_role AS ENUM ('admin','ops_orders','ops_ar','ops_logistics','ops_reports','sales_rep');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE POLICY "users see own roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "admins manage roles" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  display_name text,
  sales_rep_code text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles readable by authenticated" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid());
CREATE POLICY "users insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email,'@',1)));
  -- default everyone to ops_orders so they can see something; admin must promote
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'ops_orders') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ TIMESTAMP TRIGGER ============
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ============ ORDERS ============
CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  p21_order_id text,
  customer_id text,
  customer_name text NOT NULL,
  bill_to jsonb,
  ship_to jsonb,
  po_number text,
  source text NOT NULL DEFAULT 'manual',
  raw_input text,
  status text NOT NULL DEFAULT 'pending_review',
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_confidence numeric,
  ai_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  p21_submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orders ops read" ON public.orders FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "orders ops write" ON public.orders FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "orders ops update" ON public.orders FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "orders admin delete" ON public.orders FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.sku_crossref (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_sku text NOT NULL,
  ndi_sku text NOT NULL,
  confidence numeric DEFAULT 1.0,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(competitor_sku, ndi_sku)
);
ALTER TABLE public.sku_crossref ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sku read" ON public.sku_crossref FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "sku write" ON public.sku_crossref FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.order_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  content text NOT NULL,
  sent_at timestamptz,
  sent_to text,
  sent_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.order_acknowledgements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ack ops" ON public.order_acknowledgements FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_orders') OR public.has_role(auth.uid(),'admin'));

-- ============ SPIFF ============
CREATE TABLE public.spiff_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL,
  customer_name text NOT NULL,
  sku_filter text,
  rate_type text NOT NULL DEFAULT 'percent',
  rate_value numeric NOT NULL,
  sales_rep_split boolean NOT NULL DEFAULT false,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.spiff_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff rules ar" ON public.spiff_rules FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.spiff_calculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quarter text NOT NULL,
  customer_id text NOT NULL,
  customer_name text NOT NULL,
  sales_rep text,
  gross_sales numeric NOT NULL DEFAULT 0,
  spiff_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.spiff_calculations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spiff calc ar" ON public.spiff_calculations FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin'));

-- ============ AR ============
CREATE TABLE public.ar_aging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id text NOT NULL,
  customer_name text NOT NULL,
  customer_email text,
  invoice_number text NOT NULL,
  amount_due numeric NOT NULL,
  due_date date NOT NULL,
  days_past_due integer NOT NULL DEFAULT 0,
  bucket text NOT NULL,
  last_contacted_at timestamptz,
  collection_status text DEFAULT 'none',
  synced_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ar_aging ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ar ops" ON public.ar_aging FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.collection_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ar_aging_id uuid NOT NULL REFERENCES public.ar_aging(id) ON DELETE CASCADE,
  content text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'sent',
  sent_by uuid REFERENCES auth.users(id),
  automated boolean NOT NULL DEFAULT false
);
ALTER TABLE public.collection_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY "collection emails ar" ON public.collection_emails FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_ar') OR public.has_role(auth.uid(),'admin'));

-- ============ LOGISTICS ============
CREATE TABLE public.fleet_loads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_code text NOT NULL,
  driver_name text,
  truck_id text,
  departure_date date,
  orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_weight numeric DEFAULT 0,
  total_cubic_ft numeric DEFAULT 0,
  capacity_pct numeric DEFAULT 0,
  status text NOT NULL DEFAULT 'loading',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fleet_loads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet logistics" ON public.fleet_loads FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_logistics') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_logistics') OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.damage_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  p21_order_id text,
  samsara_document_id text,
  stage text NOT NULL DEFAULT 'delivery',
  damage_type text,
  severity text NOT NULL DEFAULT 'minor',
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  driver_name text,
  route_code text,
  dealer_id text,
  installer_id text,
  resolution text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.damage_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "damage logistics" ON public.damage_reports FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_logistics') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_logistics') OR public.has_role(auth.uid(),'admin'));

-- ============ REPORTS ============
CREATE TABLE public.report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL,
  schedule_cron text NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  template text,
  last_run_at timestamptz,
  last_status text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reports ops" ON public.report_schedules FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_reports') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_reports') OR public.has_role(auth.uid(),'admin'));

CREATE TABLE public.report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES public.report_schedules(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  output_url text,
  recipients_count integer DEFAULT 0,
  notes text
);
ALTER TABLE public.report_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "report runs ops" ON public.report_runs FOR ALL TO authenticated USING (public.has_role(auth.uid(),'ops_reports') OR public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'ops_reports') OR public.has_role(auth.uid(),'admin'));

-- ============ SALES ============
CREATE TABLE public.sales_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_code text NOT NULL,
  period text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  data jsonb NOT NULL,
  cached_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rep_code, period, date_from, date_to)
);
ALTER TABLE public.sales_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales reps own" ON public.sales_cache FOR SELECT TO authenticated USING (
  public.has_role(auth.uid(),'admin')
  OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.sales_rep_code = sales_cache.rep_code)
);
CREATE POLICY "sales admin write" ON public.sales_cache FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

-- ============ ACTIVITY ============
CREATE TABLE public.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  actor_id uuid REFERENCES auth.users(id),
  actor_name text,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "activity read" ON public.activity_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "activity insert auth" ON public.activity_events FOR INSERT TO authenticated WITH CHECK (true);

-- ============ APP SETTINGS ============
CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings admin" ON public.app_settings FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE POLICY "settings read auth" ON public.app_settings FOR SELECT TO authenticated USING (true);

INSERT INTO public.app_settings(key,value) VALUES
('ar_automation_enabled', 'true'::jsonb),
('ar_reminder_template', '"Hi {{customer_name}}, our records show invoice {{invoice}} for ${{amount}} is {{days}} days past due. Please remit at your earliest convenience or reply with any questions. Thanks — NDI."'::jsonb),
('integrations_status', '{"p21":"stub","samsara":"stub","ai":"live"}'::jsonb);

-- ============ REALTIME ============
ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
