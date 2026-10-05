-- Any NEW auth identity whose email is reserved by a warehouse-manager invite is bound to that
-- invite (created_user_id) and gets no default operator role, regardless of claim lease expiry,
-- cancel-after-claim or revoke. Reserved = any invite row for the email EXCEPT a draft that was
-- cancelled without ever being claimed (zero-effect cancellation). Pre-existing accounts are untouched
-- (this runs only on auth.users INSERT). If every reserving row is already bound to another
-- identity, creation is rejected.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_reserved boolean; v_invite uuid;
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email,'@',1)));

  PERFORM 1 FROM public.branch_manager_invites
   WHERE email_normalized = lower(NEW.email)
     AND NOT (status = 'cancelled' AND first_claimed_at IS NULL)
   FOR UPDATE;
  v_reserved := FOUND;

  IF v_reserved THEN
    SELECT id INTO v_invite FROM public.branch_manager_invites
     WHERE email_normalized = lower(NEW.email)
       AND NOT (status = 'cancelled' AND first_claimed_at IS NULL)
       AND created_user_id IS NULL
     ORDER BY (status NOT IN ('cancelled','revoked')) DESC, updated_at DESC
     LIMIT 1;
    IF v_invite IS NULL THEN
      RAISE EXCEPTION 'email reserved by a warehouse-manager invite' USING ERRCODE = '42501';
    END IF;
    PERFORM set_config('nelson.bm_rpc', 'on', true);
    UPDATE public.branch_manager_invites SET created_user_id = NEW.id WHERE id = v_invite;
    RETURN NEW;
  END IF;

  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'ops_orders') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;