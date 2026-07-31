-- Helper: the caller's sales rep code (security definer so policies don't recurse into profiles RLS)
CREATE OR REPLACE FUNCTION public.current_sales_rep_code()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT upper(trim(sales_rep_code)) FROM public.profiles WHERE id = auth.uid() AND sales_rep_code IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.is_capacity_alert_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'ops_logistics_admin')
$$;

-- 1) RULES
CREATE TABLE public.capacity_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  threshold_pct numeric NOT NULL DEFAULT 75,
  consecutive_days integer NOT NULL DEFAULT 3,
  scope text NOT NULL DEFAULT 'all',
  route_codes text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  cooldown_days integer NOT NULL DEFAULT 7,
  channels text[] NOT NULL DEFAULT '{in_app,email}',
  owner_user_id uuid,
  owner_label text,
  manager_digest boolean NOT NULL DEFAULT true,
  lookback_days integer NOT NULL DEFAULT 14,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capacity_alert_rules_threshold_chk CHECK (threshold_pct > 0 AND threshold_pct <= 100),
  CONSTRAINT capacity_alert_rules_days_chk CHECK (consecutive_days BETWEEN 3 AND 4),
  CONSTRAINT capacity_alert_rules_scope_chk CHECK (scope IN ('all','routes')),
  CONSTRAINT capacity_alert_rules_cooldown_chk CHECK (cooldown_days BETWEEN 0 AND 365)
);

GRANT SELECT ON public.capacity_alert_rules TO authenticated;
GRANT ALL ON public.capacity_alert_rules TO service_role;
ALTER TABLE public.capacity_alert_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "capacity_alert_rules_select_mgr" ON public.capacity_alert_rules
  FOR SELECT TO authenticated USING (public.is_capacity_alert_manager());

CREATE TRIGGER capacity_alert_rules_touch BEFORE UPDATE ON public.capacity_alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2) ALERTS
CREATE TABLE public.capacity_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES public.capacity_alert_rules(id) ON DELETE SET NULL,
  route_id uuid REFERENCES public.truck_capacity_routes(id) ON DELETE CASCADE,
  route_code text NOT NULL,
  route_name text,
  rep_codes text[] NOT NULL DEFAULT '{}',
  fired_at timestamptz NOT NULL DEFAULT now(),
  threshold_pct numeric NOT NULL,
  streak_days integer NOT NULL,
  streak_from date,
  streak_to date,
  avg_utilization_in_streak numeric,
  avg_month numeric,
  avg_quarter numeric,
  avg_year numeric,
  status text NOT NULL DEFAULT 'new',
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  delivery jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capacity_alerts_status_chk CHECK (status IN ('new','acknowledged','resolved'))
);

CREATE INDEX capacity_alerts_route_fired_idx ON public.capacity_alerts (route_code, fired_at DESC);
CREATE INDEX capacity_alerts_reps_idx ON public.capacity_alerts USING gin (rep_codes);

GRANT SELECT, UPDATE ON public.capacity_alerts TO authenticated;
GRANT ALL ON public.capacity_alerts TO service_role;
ALTER TABLE public.capacity_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "capacity_alerts_select_mgr" ON public.capacity_alerts
  FOR SELECT TO authenticated USING (public.is_capacity_alert_manager());

CREATE POLICY "capacity_alerts_select_own_rep" ON public.capacity_alerts
  FOR SELECT TO authenticated
  USING (public.current_sales_rep_code() IS NOT NULL AND public.current_sales_rep_code() = ANY (rep_codes));

CREATE POLICY "capacity_alerts_update_mgr" ON public.capacity_alerts
  FOR UPDATE TO authenticated USING (public.is_capacity_alert_manager()) WITH CHECK (public.is_capacity_alert_manager());

CREATE POLICY "capacity_alerts_update_own_rep" ON public.capacity_alerts
  FOR UPDATE TO authenticated
  USING (public.current_sales_rep_code() IS NOT NULL AND public.current_sales_rep_code() = ANY (rep_codes))
  WITH CHECK (public.current_sales_rep_code() IS NOT NULL AND public.current_sales_rep_code() = ANY (rep_codes));

-- 3) EVALUATION LOG
CREATE TABLE public.capacity_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES public.capacity_alert_rules(id) ON DELETE SET NULL,
  route_id uuid,
  route_code text,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  fired boolean NOT NULL DEFAULT false,
  dry_run boolean NOT NULL DEFAULT false,
  reason text NOT NULL,
  streak_days integer,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  alert_id uuid
);

CREATE INDEX capacity_alert_log_evaluated_idx ON public.capacity_alert_log (evaluated_at DESC);

GRANT SELECT ON public.capacity_alert_log TO authenticated;
GRANT ALL ON public.capacity_alert_log TO service_role;
ALTER TABLE public.capacity_alert_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "capacity_alert_log_select_mgr" ON public.capacity_alert_log
  FOR SELECT TO authenticated USING (public.is_capacity_alert_manager());

-- 4) PER-REP GOVERNANCE
CREATE TABLE public.capacity_alert_prefs (
  rep_code text PRIMARY KEY,
  opted_in boolean NOT NULL DEFAULT true,
  max_per_week integer NOT NULL DEFAULT 3,
  email_override text,
  notes text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capacity_alert_prefs_max_chk CHECK (max_per_week BETWEEN 0 AND 50)
);

GRANT SELECT ON public.capacity_alert_prefs TO authenticated;
GRANT ALL ON public.capacity_alert_prefs TO service_role;
ALTER TABLE public.capacity_alert_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "capacity_alert_prefs_select_mgr" ON public.capacity_alert_prefs
  FOR SELECT TO authenticated USING (public.is_capacity_alert_manager());

CREATE POLICY "capacity_alert_prefs_select_own" ON public.capacity_alert_prefs
  FOR SELECT TO authenticated
  USING (public.current_sales_rep_code() IS NOT NULL AND public.current_sales_rep_code() = rep_code);

CREATE TRIGGER capacity_alert_prefs_touch BEFORE UPDATE ON public.capacity_alert_prefs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Default rule matching the client's stated requirement (75% for 3 consecutive days).
INSERT INTO public.capacity_alert_rules (name, threshold_pct, consecutive_days, scope, cooldown_days, channels, active, owner_label)
VALUES ('Underfilled trucks — 75% for 3 days', 75, 3, 'all', 7, '{in_app,email}', false, 'Logistics admin');
