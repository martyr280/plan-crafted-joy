-- Invite-created identities are branch-bound from the moment generateLink creates them,
-- before bm_stage writes any role, and permanently after failure/cancel/revocation.
CREATE INDEX IF NOT EXISTS branch_manager_invites_user_id_idx ON public.branch_manager_invites (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS branch_manager_invites_created_user_id_idx ON public.branch_manager_invites (created_user_id) WHERE created_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.is_branch_manager(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT _user_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'branch_manager'::public.app_role)
    OR EXISTS (SELECT 1 FROM public.branch_manager_invites WHERE user_id = _user_id OR created_user_id = _user_id)
  )
$$;
REVOKE ALL ON FUNCTION private.is_branch_manager(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_branch_manager(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_user_is_branch_bound()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT auth.uid() IS NULL OR private.is_branch_manager(auth.uid()) $$;
REVOKE ALL ON FUNCTION public.current_user_is_branch_bound() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_is_branch_bound() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
     AND (_role = 'branch_manager'::public.app_role OR NOT private.is_branch_manager(_user_id));
$function$;

CREATE OR REPLACE FUNCTION private.bm_guard_user_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    IF OLD.role = 'branch_manager'::public.app_role OR NEW.role = 'branch_manager'::public.app_role THEN
      RAISE EXCEPTION 'branch_manager role cannot be moved between users';
    END IF;
    PERFORM private.bm_lock_user_roles(least(OLD.user_id, NEW.user_id));
    PERFORM private.bm_lock_user_roles(greatest(OLD.user_id, NEW.user_id));
  ELSE
    PERFORM private.bm_lock_user_roles(NEW.user_id);
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.role = 'branch_manager'::public.app_role OR NEW.role = 'branch_manager'::public.app_role) AND OLD.role <> NEW.role THEN
    RAISE EXCEPTION 'branch_manager role cannot be changed by update';
  END IF;
  IF NEW.role = 'branch_manager'::public.app_role THEN
    IF NOT private.bm_rpc_active() THEN RAISE EXCEPTION 'branch_manager is granted only by the confirmed invite'; END IF;
    IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role <> 'branch_manager'::public.app_role) THEN
      RAISE EXCEPTION 'branch_manager cannot be combined with other roles';
    END IF;
  ELSIF private.is_branch_manager(NEW.user_id) THEN
    RAISE EXCEPTION 'branch_manager cannot be combined with other roles';
  END IF;
  RETURN NEW;
END $function$;