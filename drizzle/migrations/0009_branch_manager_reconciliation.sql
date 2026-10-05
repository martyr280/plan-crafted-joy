ALTER TABLE public.branch_manager_invites ADD COLUMN IF NOT EXISTS created_user_id uuid;
ALTER TABLE public.branch_manager_invites ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE public.branch_manager_invites ADD COLUMN IF NOT EXISTS send_started_at timestamptz;
ALTER TABLE public.branch_manager_invites DROP CONSTRAINT IF EXISTS branch_manager_invites_status_check;
ALTER TABLE public.branch_manager_invites ADD CONSTRAINT branch_manager_invites_status_check
  CHECK (status IN ('draft','claimed','staged','sending','sent','failed','needs_reconciliation','cancelled','revoked'));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_invite uuid;
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email,'@',1)));
  SELECT id INTO v_invite FROM public.branch_manager_invites
   WHERE email_normalized = lower(NEW.email) AND status = 'claimed' AND claim_expires_at > now()
   FOR UPDATE;
  IF v_invite IS NOT NULL THEN
    PERFORM set_config('nelson.bm_rpc', 'on', true);
    UPDATE public.branch_manager_invites SET created_user_id = NEW.id WHERE id = v_invite;
    RETURN NEW;
  END IF;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'ops_orders') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.bm_activate(r public.branch_manager_invites)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  IF r.user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = r.user_id AND role = 'branch_manager'::public.app_role)
     OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = r.user_id AND role <> 'branch_manager'::public.app_role) THEN
    RAISE EXCEPTION 'inconsistent_setup' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_warehouses SET active = true WHERE user_id = r.user_id AND invite_id = r.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'inconsistent_setup' USING ERRCODE = '55000'; END IF;
END $function$;

DROP FUNCTION IF EXISTS public.bm_claim(uuid, uuid, uuid, text, text);
CREATE FUNCTION public.bm_claim(p_actor uuid, p_id uuid, p_request_key uuid, p_email text, p_warehouse text, p_ack_duplicate boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
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
  IF r.status = 'sending' AND r.claim_expires_at <= now() THEN
    PERFORM set_config('nelson.bm_rpc', 'on', true);
    UPDATE public.branch_manager_warehouses SET active = false WHERE invite_id = p_id;
    UPDATE public.branch_manager_invites SET status = 'needs_reconciliation', last_error = 'unknown_outcome',
      claim_expires_at = NULL WHERE id = p_id;
    RETURN jsonb_build_object('outcome', 'needs_reconciliation');
  END IF;
  IF r.status IN ('claimed','staged','sending') AND r.claim_expires_at > now() THEN
    IF r.request_key = p_request_key THEN RETURN jsonb_build_object('outcome', 'in_progress'); END IF;
    RAISE EXCEPTION 'in_flight' USING ERRCODE = '55P03';
  END IF;
  IF r.status = 'needs_reconciliation' AND NOT coalesce(p_ack_duplicate, false) THEN
    RETURN jsonb_build_object('outcome', 'needs_reconciliation');
  END IF;
  v_key := gen_random_uuid()::text;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_invites SET status = 'claimed', request_key = p_request_key, resend_key = v_key,
    claimed_at = now(), first_claimed_at = coalesce(first_claimed_at, now()),
    claim_expires_at = now() + interval '10 minutes', attempt_count = attempt_count + 1, last_error = NULL,
    provider_message_id = NULL, send_started_at = NULL
  WHERE id = p_id;
  RETURN jsonb_build_object('outcome', 'claimed', 'resend_key', v_key, 'user_id', r.user_id, 'display_name', r.display_name);
END $function$;

CREATE OR REPLACE FUNCTION public.bm_stage(p_id uuid, p_request_key uuid, p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE r public.branch_manager_invites%ROWTYPE; v_email text;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'claimed' OR r.request_key IS DISTINCT FROM p_request_key OR r.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'stale_claim' USING ERRCODE = '55000';
  END IF;
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

CREATE OR REPLACE FUNCTION public.bm_begin_send(p_id uuid, p_request_key uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE r public.branch_manager_invites%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'staged' OR r.request_key IS DISTINCT FROM p_request_key OR r.claim_expires_at <= now() THEN
    RAISE EXCEPTION 'stale_claim' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_invites SET status = 'sending', send_started_at = now(),
    claim_expires_at = now() + interval '10 minutes' WHERE id = p_id;
END $function$;

DROP FUNCTION IF EXISTS public.bm_mark_sent(uuid, uuid);
CREATE FUNCTION public.bm_mark_sent(p_id uuid, p_request_key uuid, p_provider_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE r public.branch_manager_invites%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'sending' OR r.request_key IS DISTINCT FROM p_request_key THEN RAISE EXCEPTION 'stale_claim' USING ERRCODE = '55000'; END IF;
  PERFORM private.bm_activate(r);
  UPDATE public.branch_manager_invites SET status = 'sent', sent_at = now(), claim_expires_at = NULL,
    provider_message_id = left(p_provider_id, 200) WHERE id = p_id;
END $function$;

DROP FUNCTION IF EXISTS public.bm_mark_failed(uuid, uuid, text);
CREATE FUNCTION public.bm_mark_failed(p_id uuid, p_request_key uuid, p_code text, p_provider_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE r public.branch_manager_invites%ROWTYPE; v_status text; v_code text;
BEGIN
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN ('claimed','staged','sending') OR r.request_key IS DISTINCT FROM p_request_key THEN RETURN NULL; END IF;
  v_code := CASE WHEN p_code IN ('unknown_outcome','link_failed','user_mismatch','existing_account','existing_privileged_account','user_mapped_elsewhere','send_failed','stage_failed','activation_failed') THEN p_code ELSE 'failed' END;
  v_status := CASE WHEN r.status = 'sending' AND v_code <> 'send_failed' THEN 'needs_reconciliation' ELSE 'failed' END;
  PERFORM set_config('nelson.bm_rpc', 'on', true);
  UPDATE public.branch_manager_warehouses SET active = false WHERE invite_id = p_id;
  UPDATE public.branch_manager_invites SET status = v_status, claim_expires_at = NULL, last_error = v_code,
    provider_message_id = CASE WHEN r.status = 'sending' THEN left(p_provider_id, 200) ELSE NULL END
  WHERE id = p_id;
  RETURN v_status;
END $function$;

CREATE OR REPLACE FUNCTION public.bm_finish_activation(p_actor uuid, p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE r public.branch_manager_invites%ROWTYPE;
BEGIN
  PERFORM private.bm_assert_admin(p_actor);
  SELECT * INTO r FROM public.branch_manager_invites WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF r.status = 'sent' THEN RETURN 'sent'; END IF;
  IF r.status <> 'needs_reconciliation' OR r.provider_message_id IS NULL THEN
    RAISE EXCEPTION 'not_confirmed_delivered' USING ERRCODE = '55000';
  END IF;
  PERFORM private.bm_activate(r);
  UPDATE public.branch_manager_invites SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = p_id;
  RETURN 'sent';
END $function$;

CREATE OR REPLACE FUNCTION public.bm_cancel(p_actor uuid, p_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
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
  IF r.status IN ('claimed','staged','sending') AND r.claim_expires_at > now() THEN RAISE EXCEPTION 'in_flight' USING ERRCODE = '55P03'; END IF;
  UPDATE public.branch_manager_warehouses SET active = false WHERE invite_id = p_id;
  IF r.user_id IS NOT NULL THEN
    DELETE FROM public.user_roles WHERE user_id = r.user_id AND role = 'branch_manager'::public.app_role;
  END IF;
  UPDATE public.branch_manager_invites SET status = 'revoked', request_key = NULL, claim_expires_at = NULL WHERE id = p_id;
  RETURN 'revoked';
END $function$;

REVOKE ALL ON FUNCTION public.bm_claim(uuid, uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bm_begin_send(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bm_mark_sent(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bm_mark_failed(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bm_finish_activation(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bm_stage(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bm_cancel(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.bm_activate(public.branch_manager_invites) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bm_claim(uuid, uuid, uuid, text, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.bm_begin_send(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bm_mark_sent(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bm_mark_failed(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.bm_finish_activation(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bm_stage(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.bm_cancel(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION private.bm_activate(public.branch_manager_invites) TO service_role;