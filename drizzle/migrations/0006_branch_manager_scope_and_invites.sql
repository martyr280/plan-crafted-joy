-- Warehouse manager (branch_manager): scoped mapping, invite operations, restrictive deny, guarded RPCs.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_branch_manager(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'branch_manager'::public.app_role) $$;
REVOKE ALL ON FUNCTION private.is_branch_manager(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_branch_manager(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.bm_rpc_active() RETURNS boolean LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT coalesce(current_setting('nelson.bm_rpc', true), '') = 'on' $$;
REVOKE ALL ON FUNCTION private.bm_rpc_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.bm_rpc_active() TO service_role;

CREATE TABLE public.branch_manager_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  display_name text,
  warehouse text NOT NULL CHECK (warehouse IN ('Birmingham','Dallas','Ocala')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','claimed','staged','sent','failed','cancelled','revoked')),
  user_id uuid,
  request_key uuid,
  resend_key text,
  first_claimed_at timestamptz,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branch_manager_invites_open_email ON public.branch_manager_invites (email_normalized)
  WHERE status NOT IN ('cancelled','revoked');
GRANT ALL ON public.branch_manager_invites TO service_role;
ALTER TABLE public.branch_manager_invites ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.branch_manager_invites IS 'Warehouse-manager invite preparation and operation state. Written only by bm_* RPCs (service role).';

CREATE TABLE public.branch_manager_warehouses (
  user_id uuid PRIMARY KEY,
  warehouse text NOT NULL CHECK (warehouse IN ('Birmingham','Dallas','Ocala')),
  active boolean NOT NULL DEFAULT false,
  invite_id uuid NOT NULL REFERENCES public.branch_manager_invites(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.branch_manager_warehouses TO authenticated;
GRANT ALL ON public.branch_manager_warehouses TO service_role;
ALTER TABLE public.branch_manager_warehouses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own warehouse mapping or admin" ON public.branch_manager_warehouses FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'::public.app_role));
COMMENT ON TABLE public.branch_manager_warehouses IS 'One warehouse per branch manager. Active only after a sent invite. Written only by bm_* RPCs.';

-- Writes to both tables only from inside bm_* RPCs.
CREATE OR REPLACE FUNCTION private.bm_guard_writes() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT private.bm_rpc_active() THEN RAISE EXCEPTION 'branch_manager tables are written only by bm_* functions'; END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'branch_manager rows are never deleted'; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bm_guard_invites BEFORE INSERT OR UPDATE OR DELETE ON public.branch_manager_invites FOR EACH ROW EXECUTE FUNCTION private.bm_guard_writes();
CREATE TRIGGER bm_guard_mapping BEFORE INSERT OR UPDATE OR DELETE ON public.branch_manager_warehouses FOR EACH ROW EXECUTE FUNCTION private.bm_guard_writes();

-- branch_manager is exclusive and only granted through bm_stage.
CREATE OR REPLACE FUNCTION private.bm_guard_user_roles() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.role = 'branch_manager'::public.app_role OR NEW.role = 'branch_manager'::public.app_role) AND OLD.role <> NEW.role THEN
    RAISE EXCEPTION 'branch_manager role cannot be changed by update';
  END IF;
  IF NEW.role = 'branch_manager'::public.app_role THEN
    IF NOT private.bm_rpc_active() THEN RAISE EXCEPTION 'branch_manager is granted only by the confirmed invite'; END IF;
    IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role <> 'branch_manager'::public.app_role) THEN
      RAISE EXCEPTION 'branch_manager cannot be combined with other roles';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.user_id AND role = 'branch_manager'::public.app_role) THEN
    RAISE EXCEPTION 'branch_manager cannot be combined with other roles';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bm_guard_user_roles BEFORE INSERT OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION private.bm_guard_user_roles();

-- Restrictive deny for branch managers on every other public table; composes (AND) with existing permissive policies.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename NOT IN ('user_roles','profiles','branch_manager_warehouses','branch_manager_invites') LOOP
    EXECUTE format('CREATE POLICY branch_manager_deny ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (SELECT private.is_branch_manager(auth.uid()))) WITH CHECK (NOT (SELECT private.is_branch_manager(auth.uid())))', t.tablename);
  END LOOP;
END $$;
CREATE POLICY branch_manager_deny ON public.user_roles AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (SELECT private.is_branch_manager(auth.uid())) OR user_id = auth.uid())
  WITH CHECK (NOT (SELECT private.is_branch_manager(auth.uid())));
CREATE POLICY branch_manager_deny ON public.profiles AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (SELECT private.is_branch_manager(auth.uid())) OR id = auth.uid())
  WITH CHECK (NOT (SELECT private.is_branch_manager(auth.uid())));
CREATE POLICY branch_manager_deny ON public.branch_manager_warehouses AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (SELECT private.is_branch_manager(auth.uid())) OR user_id = auth.uid())
  WITH CHECK (false);
CREATE POLICY branch_manager_deny ON public.branch_manager_invites AS RESTRICTIVE FOR ALL TO authenticated
  USING (false) WITH CHECK (false);

-- Admin bootstrap must never grant admin to a branch manager.
CREATE OR REPLACE FUNCTION public.claim_admin_if_none()
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  has_any_admin boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF private.is_branch_manager(auth.uid()) THEN
    RAISE EXCEPTION 'Not permitted';
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE role = 'admin') INTO has_any_admin;
  IF has_any_admin THEN
    RETURN false;
  END IF;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (auth.uid(), 'admin')
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$function$;

-- ---------- Invite state machine (service role only) ----------
CREATE OR REPLACE FUNCTION private.bm_assert_admin(p_actor uuid) RETURNS void LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'admin'::public.app_role)
     OR private.is_branch_manager(p_actor) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION private.bm_assert_admin(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.bm_norm_email(p text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE e text := lower(btrim(coalesce(p, '')));
BEGIN
  IF length(e) > 255 OR e !~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$' THEN RAISE EXCEPTION 'invalid_email' USING ERRCODE = '22023'; END IF;
  RETURN e;
END $$;
REVOKE ALL ON FUNCTION private.bm_norm_email(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bm_save_draft(p_actor uuid, p_id uuid, p_email text, p_display_name text, p_warehouse text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email text; v_id uuid; v_status text;
BEGIN
  PERFORM private.bm_assert_admin(p_actor);
  v_email := private.bm_norm_email(p_email);
  IF p_warehouse IS NULL OR p_warehouse NOT IN ('Birmingham','Dallas','Ocala') THEN RAISE EXCEPTION 'invalid_warehouse' USING ERRCODE = '22023'; END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO public.branch_manager_invites (email_normalized, display_name, warehouse, created_by)
      VALUES (v_email, nullif(btrim(p_display_name), ''), p_warehouse, p_actor) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'duplicate_email' USING ERRCODE = '23505';
    END;
  ELSE
    SELECT status INTO v_status FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
    IF v_status IS NULL THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'not_editable' USING ERRCODE = '55000'; END IF;
    BEGIN
      UPDATE public.branch_manager_invites SET email_normalized = v_email, display_name = nullif(btrim(p_display_name), ''), warehouse = p_warehouse
      WHERE id = p_id RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'duplicate_email' USING ERRCODE = '23505';
    END;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.bm_cancel(p_actor uuid, p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.branch_manager_invites%ROWTYPE;
BEGIN
  PERFORM private.bm_assert_admin(p_actor);
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  IF r.status = 'draft' THEN
    UPDATE public.branch_manager_invites SET status = 'cancelled' WHERE id = p_id;
    RETURN 'cancelled';
  END IF;
  IF r.status IN ('cancelled','revoked') THEN RETURN r.status; END IF;
  IF r.status IN ('claimed','staged') AND r.claim_expires_at > now() THEN RAISE EXCEPTION 'in_flight' USING ERRCODE = '55P03'; END IF;
  -- Revoke: deactivate mapping, remove only the branch_manager role row; never delete the auth account.
  UPDATE public.branch_manager_warehouses SET active = false WHERE invite_id = p_id;
  IF r.user_id IS NOT NULL THEN
    DELETE FROM public.user_roles WHERE user_id = r.user_id AND role = 'branch_manager'::public.app_role;
  END IF;
  UPDATE public.branch_manager_invites SET status = 'revoked', request_key = NULL, claim_expires_at = NULL WHERE id = p_id;
  RETURN 'revoked';
END $$;

CREATE OR REPLACE FUNCTION public.bm_claim(p_actor uuid, p_id uuid, p_request_key uuid, p_email text, p_warehouse text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.branch_manager_invites%ROWTYPE; v_key text;
BEGIN
  PERFORM private.bm_assert_admin(p_actor);
  IF p_request_key IS NULL THEN RAISE EXCEPTION 'missing_request_key' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.email_normalized <> private.bm_norm_email(p_email) OR r.warehouse <> p_warehouse THEN
    RAISE EXCEPTION 'request_mismatch' USING ERRCODE = '22023';
  END IF;
  IF r.status = 'sent' THEN RETURN jsonb_build_object('outcome', 'already_sent'); END IF;
  IF r.status IN ('cancelled','revoked') THEN RAISE EXCEPTION 'not_invitable' USING ERRCODE = '55000'; END IF;
  IF r.status IN ('claimed','staged') AND r.claim_expires_at > now() THEN
    IF r.request_key = p_request_key THEN RETURN jsonb_build_object('outcome', 'in_progress'); END IF;
    RAISE EXCEPTION 'in_flight' USING ERRCODE = '55P03';
  END IF;
  -- Unknown provider outcome keeps the same provider idempotency key so a retry cannot double-send.
  v_key := CASE WHEN r.last_error = 'unknown_outcome' AND r.resend_key IS NOT NULL THEN r.resend_key ELSE gen_random_uuid()::text END;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_invites SET status = 'claimed', request_key = p_request_key, resend_key = v_key,
    claimed_at = now(), first_claimed_at = coalesce(first_claimed_at, now()),
    claim_expires_at = now() + interval '10 minutes', attempt_count = attempt_count + 1, last_error = NULL
  WHERE id = p_id;
  RETURN jsonb_build_object('outcome', 'claimed', 'resend_key', v_key, 'user_id', r.user_id, 'display_name', r.display_name);
END $$;

CREATE OR REPLACE FUNCTION public.bm_stage(p_id uuid, p_request_key uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.branch_manager_invites%ROWTYPE; v_email text; v_created timestamptz;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'claimed' OR r.request_key IS DISTINCT FROM p_request_key OR r.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'stale_claim' USING ERRCODE = '55000';
  END IF;
  SELECT lower(email), created_at INTO v_email, v_created FROM auth.users WHERE id = p_user_id;
  IF v_email IS NULL OR v_email <> r.email_normalized THEN RAISE EXCEPTION 'user_mismatch' USING ERRCODE = '22023'; END IF;
  IF r.user_id IS NOT NULL AND r.user_id <> p_user_id THEN RAISE EXCEPTION 'user_mismatch' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_user_id AND role NOT IN ('ops_orders'::public.app_role, 'branch_manager'::public.app_role)) THEN
    RAISE EXCEPTION 'existing_privileged_account' USING ERRCODE = '42501';
  END IF;
  -- An account that predates this invite is someone's existing login: never convert it.
  IF r.user_id IS NULL AND v_created < r.first_claimed_at - interval '5 seconds' THEN
    RAISE EXCEPTION 'existing_account' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.branch_manager_warehouses WHERE user_id = p_user_id AND invite_id <> p_id) THEN
    RAISE EXCEPTION 'user_mapped_elsewhere' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  DELETE FROM public.user_roles WHERE user_id = p_user_id AND role = 'ops_orders'::public.app_role;  -- default signup role
  INSERT INTO public.user_roles (user_id, role) VALUES (p_user_id, 'branch_manager') ON CONFLICT DO NOTHING;
  INSERT INTO public.branch_manager_warehouses (user_id, warehouse, active, invite_id) VALUES (p_user_id, r.warehouse, false, p_id)
    ON CONFLICT (user_id) DO UPDATE SET warehouse = EXCLUDED.warehouse, active = false;
  UPDATE public.branch_manager_invites SET status = 'staged', user_id = p_user_id WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION public.bm_mark_sent(p_id uuid, p_request_key uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.branch_manager_invites%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'staged' OR r.request_key IS DISTINCT FROM p_request_key THEN RAISE EXCEPTION 'stale_claim' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = r.user_id AND role = 'branch_manager'::public.app_role)
     OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = r.user_id AND role <> 'branch_manager'::public.app_role) THEN
    RAISE EXCEPTION 'inconsistent_setup' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_warehouses SET active = true WHERE user_id = r.user_id AND invite_id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'inconsistent_setup' USING ERRCODE = '55000'; END IF;
  UPDATE public.branch_manager_invites SET status = 'sent', sent_at = now(), claim_expires_at = NULL WHERE id = p_id;
END $$;

CREATE OR REPLACE FUNCTION public.bm_mark_failed(p_id uuid, p_request_key uuid, p_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.branch_manager_invites%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN ('claimed','staged') OR r.request_key IS DISTINCT FROM p_request_key THEN RETURN; END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_warehouses SET active = false WHERE invite_id = p_id;
  UPDATE public.branch_manager_invites SET status = 'failed', claim_expires_at = NULL,
    last_error = CASE WHEN p_code IN ('unknown_outcome','link_failed','user_mismatch','existing_account','existing_privileged_account','user_mapped_elsewhere','send_failed','stage_failed') THEN p_code ELSE 'failed' END
  WHERE id = p_id;
END $$;

REVOKE ALL ON FUNCTION public.bm_save_draft(uuid,uuid,text,text,text), public.bm_cancel(uuid,uuid),
  public.bm_claim(uuid,uuid,uuid,text,text), public.bm_stage(uuid,uuid,uuid), public.bm_mark_sent(uuid,uuid),
  public.bm_mark_failed(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bm_save_draft(uuid,uuid,text,text,text), public.bm_cancel(uuid,uuid),
  public.bm_claim(uuid,uuid,uuid,text,text), public.bm_stage(uuid,uuid,uuid), public.bm_mark_sent(uuid,uuid),
  public.bm_mark_failed(uuid,uuid,text) TO service_role;
