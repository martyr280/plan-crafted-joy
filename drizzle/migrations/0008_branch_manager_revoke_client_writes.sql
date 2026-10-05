-- Default privileges granted more than intended; clients get read-only own mapping and nothing on invites.
REVOKE ALL ON public.branch_manager_invites FROM anon, authenticated;
REVOKE ALL ON public.branch_manager_warehouses FROM anon, authenticated;
GRANT SELECT ON public.branch_manager_warehouses TO authenticated;