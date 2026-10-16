CREATE TABLE public.truck_capacity_shadow_forecast_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES public.truck_capacity_routes(id),
  forecast_date date NOT NULL,
  made_on date NOT NULL,
  predicted numeric,
  method text NOT NULL DEFAULT 'route_median_v1',
  n_history integer NOT NULL,
  source text NOT NULL CHECK (source IN ('backfill_pit','daily')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, forecast_date, made_on, method)
);
GRANT SELECT ON public.truck_capacity_shadow_forecast_log TO authenticated;
GRANT ALL ON public.truck_capacity_shadow_forecast_log TO service_role;
ALTER TABLE public.truck_capacity_shadow_forecast_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read shadow forecast log" ON public.truck_capacity_shadow_forecast_log
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);
CREATE POLICY "branch_manager_deny" ON public.truck_capacity_shadow_forecast_log
  AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (SELECT private.is_branch_manager(auth.uid())));

CREATE OR REPLACE FUNCTION public.tc_shadow_route_median(p_route uuid, p_made_on date, p_known_before timestamptz)
RETURNS TABLE(predicted numeric, n_history int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (
    SELECT run_date, avg(capacity_frac) AS y
    FROM public.truck_capacity_runs
    WHERE route_id = p_route AND run_date < p_made_on AND created_at < p_known_before
      AND capacity_frac IS NOT NULL
    GROUP BY route_id, run_date
  )
  SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY y))::numeric, count(*)::int FROM d
$$;
REVOKE EXECUTE ON FUNCTION public.tc_shadow_route_median(uuid, date, timestamptz) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tc_shadow_log_for(p_made_on date, p_known_before timestamptz, p_source text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.truck_capacity_shadow_forecast_log (route_id, forecast_date, made_on, predicted, method, n_history, source)
  SELECT r.id, (p_made_on + g.k)::date, p_made_on, m.predicted, 'route_median_v1', m.n_history, p_source
  FROM public.truck_capacity_routes r
  CROSS JOIN LATERAL public.tc_shadow_route_median(r.id, p_made_on, p_known_before) m
  CROSS JOIN generate_series(1, 28) AS g(k)
  WHERE r.active = true
  ON CONFLICT (route_id, forecast_date, made_on, method) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION public.tc_shadow_log_for(date, timestamptz, text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tc_shadow_log_daily()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.tc_shadow_log_for((now() AT TIME ZONE 'America/Chicago')::date, now(), 'daily')
$$;
REVOKE EXECUTE ON FUNCTION public.tc_shadow_log_daily() FROM public, anon, authenticated;

SELECT public.tc_shadow_log_for(d::date, (d::timestamp + interval '8 hours') AT TIME ZONE 'UTC', 'backfill_pit')
FROM generate_series('2026-08-01'::date, '2026-10-16'::date, interval '1 day') AS d;

SELECT cron.schedule('truck-shadow-median-daily', '20 8 * * *', $cron$SELECT public.tc_shadow_log_daily()$cron$);

CREATE VIEW public.tc_scoreboard_v1_pairs WITH (security_invoker = true) AS
WITH actuals AS (
  SELECT route_id, run_date, avg(capacity_frac) AS y, count(*)::int AS n_runs
  FROM public.truck_capacity_runs WHERE capacity_frac IS NOT NULL AND route_id IS NOT NULL
  GROUP BY route_id, run_date
),
live AS (
  SELECT DISTINCT ON (a.route_id, a.run_date) a.route_id, a.run_date,
    coalesce(f.served, f.predicted) AS live_value, f.made_on AS live_made_on
  FROM actuals a
  JOIN public.truck_capacity_forecast_log f
    ON f.route_id = a.route_id AND f.forecast_date = a.run_date AND f.made_on <= a.run_date - 1
  ORDER BY a.route_id, a.run_date, f.made_on DESC, f.created_at DESC
),
base AS (
  SELECT a.route_id, r.code, r.hub, a.run_date, a.n_runs, a.y AS actual,
    l.live_value, l.live_made_on, s.predicted AS shadow_value, s.made_on AS shadow_made_on, s.source AS shadow_source
  FROM actuals a
  JOIN public.truck_capacity_routes r ON r.id = a.route_id
  LEFT JOIN live l ON l.route_id = a.route_id AND l.run_date = a.run_date
  LEFT JOIN LATERAL (
    SELECT sf.predicted, sf.made_on, sf.source
    FROM public.truck_capacity_shadow_forecast_log sf
    WHERE sf.method = 'route_median_v1' AND sf.route_id = a.route_id AND sf.forecast_date = a.run_date
      AND CASE WHEN l.live_made_on IS NOT NULL THEN sf.made_on = l.live_made_on
               ELSE sf.made_on <= a.run_date - 1 END
    ORDER BY sf.made_on DESC LIMIT 1
  ) s ON true
)
SELECT route_id, code, hub, run_date, n_runs, actual, live_value, live_made_on,
  shadow_value, shadow_made_on, shadow_source,
  abs(live_value - actual) AS live_abs_err, abs(shadow_value - actual) AS shadow_abs_err,
  (live_value - actual) AS live_err, (shadow_value - actual) AS shadow_err,
  CASE WHEN run_date BETWEEN '2026-08-23' AND '2026-10-12' THEN 'frozen_holdout_v1'
       WHEN run_date >= '2026-10-13' THEN 'post_freeze' ELSE 'pre_window' END AS score_window,
  CASE WHEN live_value IS NULL THEN 'no_live_forecast'
       WHEN shadow_value IS NULL THEN 'no_shadow_forecast' END AS exclusion_reason,
  (live_value IS NOT NULL AND shadow_value IS NOT NULL) AS paired
FROM base;

CREATE VIEW public.tc_scoreboard_v1 WITH (security_invoker = true) AS
SELECT score_window,
  CASE WHEN GROUPING(hub) = 1 THEN 'All hubs' ELSE hub END AS hub,
  count(*)::int AS route_days,
  count(*) FILTER (WHERE paired)::int AS paired,
  count(*) FILTER (WHERE exclusion_reason = 'no_live_forecast')::int AS excluded_no_live,
  count(*) FILTER (WHERE exclusion_reason = 'no_shadow_forecast')::int AS excluded_no_shadow,
  max(run_date) AS newest_actual,
  count(*) FILTER (WHERE paired AND live_abs_err <= 0.05 + 1e-9)::int AS live_w5,
  count(*) FILTER (WHERE paired AND live_abs_err <= 0.10 + 1e-9)::int AS live_w10,
  round(100.0 * count(*) FILTER (WHERE paired AND live_abs_err <= 0.05 + 1e-9) / nullif(count(*) FILTER (WHERE paired), 0), 1) AS live_w5_pct,
  round(100.0 * count(*) FILTER (WHERE paired AND live_abs_err <= 0.10 + 1e-9) / nullif(count(*) FILTER (WHERE paired), 0), 1) AS live_w10_pct,
  round((avg(live_abs_err) FILTER (WHERE paired) * 100)::numeric, 1) AS live_mae_pts,
  round((avg(live_err) FILTER (WHERE paired) * 100)::numeric, 1) AS live_bias_pts,
  count(*) FILTER (WHERE paired AND shadow_abs_err <= 0.05 + 1e-9)::int AS median_w5,
  count(*) FILTER (WHERE paired AND shadow_abs_err <= 0.10 + 1e-9)::int AS median_w10,
  round(100.0 * count(*) FILTER (WHERE paired AND shadow_abs_err <= 0.05 + 1e-9) / nullif(count(*) FILTER (WHERE paired), 0), 1) AS median_w5_pct,
  round(100.0 * count(*) FILTER (WHERE paired AND shadow_abs_err <= 0.10 + 1e-9) / nullif(count(*) FILTER (WHERE paired), 0), 1) AS median_w10_pct,
  round((avg(shadow_abs_err) FILTER (WHERE paired) * 100)::numeric, 1) AS median_mae_pts,
  round((avg(shadow_err) FILTER (WHERE paired) * 100)::numeric, 1) AS median_bias_pts
FROM public.tc_scoreboard_v1_pairs
GROUP BY GROUPING SETS ((score_window, hub), (score_window));

GRANT SELECT ON public.tc_scoreboard_v1_pairs TO authenticated;
GRANT SELECT ON public.tc_scoreboard_v1 TO authenticated;