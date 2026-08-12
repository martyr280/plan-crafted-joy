REVOKE EXECUTE ON FUNCTION public.is_driver_time_viewer() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.is_driver_time_viewer() TO authenticated, service_role;