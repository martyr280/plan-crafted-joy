REVOKE EXECUTE ON FUNCTION public.current_sales_rep_code() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_capacity_alert_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_sales_rep_code() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_capacity_alert_manager() TO authenticated, service_role;
