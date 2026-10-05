CREATE OR REPLACE FUNCTION private.bm_lock_user_roles(_user_id uuid)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended('nelson.user_roles:' || _user_id::text, 0))
$function$;
REVOKE ALL ON FUNCTION private.bm_lock_user_roles(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.bm_guard_user_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  -- Serialize every role mutation per user (all users, all roles) so concurrent inserts of
  -- different roles cannot both pass the mixed-role check. Fixed lock order avoids deadlock.
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
  -- Each statement below runs with a fresh snapshot taken after the lock, so it sees the
  -- other transaction's committed role row.
  IF NEW.role = 'branch_manager'::public.app_role THEN
    IF NOT private.bm_rpc_active() THEN RAISE EXCEPTION 'branch_manager is granted only by the confirmed invite'; END IF;
    IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role <> 'branch_manager'::public.app_role) THEN
      RAISE EXCEPTION 'branch_manager cannot be combined with other roles';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role = 'branch_manager'::public.app_role) THEN
    RAISE EXCEPTION 'branch_manager cannot be combined with other roles';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION private.bm_guard_user_roles() FROM PUBLIC, anon, authenticated;

-- Stage takes the same per-user lock before its role checks, so a racing privileged-role
-- insert either commits first (stage then sees it and refuses) or waits and is refused by the trigger.
CREATE OR REPLACE FUNCTION public.bm_stage(p_id uuid, p_request_key uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE r public.branch_manager_invites%ROWTYPE; v_email text;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'claimed' OR r.request_key IS DISTINCT FROM p_request_key OR r.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'stale_claim' USING ERRCODE = '55000';
  END IF;
  PERFORM private.bm_lock_user_roles(p_user_id);
  SELECT lower(email) INTO v_email FROM auth.users WHERE id = p_user_id;
  IF v_email IS NULL OR v_email <> r.email_normalized THEN RAISE EXCEPTION 'user_mismatch' USING ERRCODE = '22023'; END IF;
  IF r.user_id IS NOT NULL AND r.user_id <> p_user_id THEN RAISE EXCEPTION 'user_mismatch' USING ERRCODE = '22023'; END IF;
  IF r.user_id IS NULL AND r.created_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'existing_account' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_user_id AND role <> 'branch_manager'::public.app_role) THEN
    RAISE EXCEPTION 'existing_privileged_account' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.branch_manager_warehouses WHERE user_id = p_user_id AND invite_id <> p_id) THEN
    RAISE EXCEPTION 'user_mapped_elsewhere' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  INSERT INTO public.user_roles (user_id, role) VALUES (p_user_id, 'branch_manager') ON CONFLICT DO NOTHING;
  INSERT INTO public.branch_manager_warehouses (user_id, warehouse, active, invite_id) VALUES (p_user_id, r.warehouse, false, p_id)
    ON CONFLICT (user_id) DO UPDATE SET warehouse = EXCLUDED.warehouse, active = false;
  UPDATE public.branch_manager_invites SET status = 'staged', user_id = p_user_id WHERE id = p_id;
END $function$;
REVOKE ALL ON FUNCTION public.bm_stage(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bm_stage(uuid, uuid, uuid) TO service_role;

-- Defense in depth for every has_role policy (including storage pricer-pdfs): a user who holds
-- branch_manager is never granted any other role, even if mixed rows were inserted manually.
-- Non-branch users: identical result to before.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
     AND (_role = 'branch_manager'::public.app_role
          OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'branch_manager'::public.app_role));
$function$;