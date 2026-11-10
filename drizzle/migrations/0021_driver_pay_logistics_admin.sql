-- Driver pay: logistics admins may read and maintain rates.
-- Global admins keep the existing ALL policy (including delete).
-- The restrictive branch_manager_deny policy is not changed. A branch manager,
-- including a combined branch-manager + admin row, still cannot see or write rates:
-- has_role() returns false for non-branch roles when private.is_branch_manager is true,
-- and the restrictive policy denies the row even if that check were skipped.
-- This migration does not grant any role and does not insert rate rows.
-- Same SQL as supabase/migrations/20261110120000_driver_pay_logistics_admin.sql.
-- Idempotent policy replace so applying either copy leaves one set of policies.

CREATE OR REPLACE FUNCTION public.can_manage_driver_pay(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT public.has_role(_user_id, 'admin'::public.app_role)
      OR public.has_role(_user_id, 'ops_logistics_admin'::public.app_role);
$$;

REVOKE ALL ON FUNCTION public.can_manage_driver_pay(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_driver_pay(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Logistics admins read driver pay rates" ON public.driver_pay_rates;
CREATE POLICY "Logistics admins read driver pay rates"
  ON public.driver_pay_rates
  FOR SELECT
  TO authenticated
  USING (public.can_manage_driver_pay(auth.uid()));

DROP POLICY IF EXISTS "Logistics admins insert driver pay rates" ON public.driver_pay_rates;
CREATE POLICY "Logistics admins insert driver pay rates"
  ON public.driver_pay_rates
  FOR INSERT
  TO authenticated
  WITH CHECK (public.can_manage_driver_pay(auth.uid()));

DROP POLICY IF EXISTS "Logistics admins update driver pay rates" ON public.driver_pay_rates;
CREATE POLICY "Logistics admins update driver pay rates"
  ON public.driver_pay_rates
  FOR UPDATE
  TO authenticated
  USING (public.can_manage_driver_pay(auth.uid()))
  WITH CHECK (public.can_manage_driver_pay(auth.uid()));

-- No DELETE policy for logistics admins. Delete stays on "Admins manage driver pay rates".

/*
Undo (do not run as part of this migration):

DROP POLICY IF EXISTS "Logistics admins read driver pay rates" ON public.driver_pay_rates;
DROP POLICY IF EXISTS "Logistics admins insert driver pay rates" ON public.driver_pay_rates;
DROP POLICY IF EXISTS "Logistics admins update driver pay rates" ON public.driver_pay_rates;
REVOKE ALL ON FUNCTION public.can_manage_driver_pay(uuid) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.can_manage_driver_pay(uuid);

-- Leaves "Admins manage driver pay rates" and restrictive branch_manager_deny in place.
-- Does not change user_roles and does not delete driver_pay_rates rows.
*/
