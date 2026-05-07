-- 1. Restrict profiles SELECT to self or admin
DROP POLICY IF EXISTS "profiles readable by authenticated" ON public.profiles;
CREATE POLICY "users read own profile or admin reads all"
ON public.profiles FOR SELECT TO authenticated
USING (id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- 2. Make user_roles admin policy explicit USING + WITH CHECK, split per command for clarity
DROP POLICY IF EXISTS "admins manage roles" ON public.user_roles;
CREATE POLICY "admins insert roles" ON public.user_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admins update roles" ON public.user_roles
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admins delete roles" ON public.user_roles
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 3. Realtime: restrict channel subscriptions to authorized roles
-- Topics: 'orders' requires ops_orders/admin; 'activity_events' requires any ops role/admin
CREATE POLICY "authorized realtime subscriptions"
ON realtime.messages FOR SELECT TO authenticated
USING (
  CASE realtime.topic()
    WHEN 'orders' THEN (
      public.has_role(auth.uid(), 'admin') OR
      public.has_role(auth.uid(), 'ops_orders') OR
      public.has_role(auth.uid(), 'sales_rep')
    )
    WHEN 'activity_events' THEN (
      public.has_role(auth.uid(), 'admin') OR
      public.has_role(auth.uid(), 'ops_orders') OR
      public.has_role(auth.uid(), 'ops_ar') OR
      public.has_role(auth.uid(), 'ops_logistics') OR
      public.has_role(auth.uid(), 'ops_reports') OR
      public.has_role(auth.uid(), 'sales_rep')
    )
    ELSE false
  END
);

-- 4. Lock down SECURITY DEFINER functions: revoke broad EXECUTE
-- Trigger-only functions: no direct execute needed
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;
-- has_role: needed by RLS for authenticated; revoke from anon
REVOKE ALL ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
-- claim_admin_if_none: only authenticated callers
REVOKE ALL ON FUNCTION public.claim_admin_if_none() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_admin_if_none() TO authenticated;