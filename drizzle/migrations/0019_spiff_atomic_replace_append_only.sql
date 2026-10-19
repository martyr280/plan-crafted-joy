CREATE OR REPLACE FUNCTION public.replace_spiff_run(p_run_id uuid, p_expected_line_count int, p_expected_edit_count int, p_lines jsonb, p_checks jsonb, p_audit jsonb, p_totals jsonb, p_date_from date, p_date_to date, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_status text;
  v_old_lines int;
  v_old_edits int;
  v_lines int;
  v_checks int;
  v_audit int;
BEGIN
  IF coalesce(auth.role(), current_setting('request.jwt.claims', true)::jsonb->>'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;
  SELECT status INTO v_status FROM public.spiff_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR v_status <> 'draft' THEN RAISE EXCEPTION 'run must be draft'; END IF;
  -- Block concurrent line edits between the count check and replacement.
  LOCK TABLE public.spiff_run_lines, public.spiff_line_edits, public.spiff_checks IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_old_lines FROM public.spiff_run_lines WHERE run_id = p_run_id;
  SELECT count(*) INTO v_old_edits FROM public.spiff_line_edits WHERE run_id = p_run_id;
  IF v_old_lines IS DISTINCT FROM p_expected_line_count OR v_old_edits IS DISTINCT FROM p_expected_edit_count THEN
    RAISE EXCEPTION 'run changed during generate';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_typeof(p_checks) IS DISTINCT FROM 'array' OR jsonb_typeof(p_audit) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'replacement inputs must be arrays';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines || p_checks || p_audit) x WHERE (x->>'run_id')::uuid IS DISTINCT FROM p_run_id) THEN
    RAISE EXCEPTION 'replacement row belongs to another run';
  END IF;
  INSERT INTO public.spiff_line_edits(run_id, line_key, field, old_value, new_value, changed_by, source)
  VALUES (p_run_id, '*', '_regenerate', v_old_lines::text, jsonb_array_length(p_lines)::text, p_actor, 'generate');
  DELETE FROM public.spiff_checks WHERE run_id = p_run_id;
  DELETE FROM public.spiff_run_lines WHERE run_id = p_run_id;
  INSERT INTO public.spiff_run_lines SELECT * FROM jsonb_populate_recordset(null::public.spiff_run_lines, coalesce((SELECT jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'created_at', now(), 'flags', '{}'::jsonb) || x) FROM jsonb_array_elements(p_lines) x), '[]'::jsonb));
  GET DIAGNOSTICS v_lines = ROW_COUNT;
  INSERT INTO public.spiff_checks SELECT * FROM jsonb_populate_recordset(null::public.spiff_checks, coalesce((SELECT jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'created_at', now(), 'updated_at', now()) || x) FROM jsonb_array_elements(p_checks) x), '[]'::jsonb));
  GET DIAGNOSTICS v_checks = ROW_COUNT;
  INSERT INTO public.spiff_line_edits SELECT * FROM jsonb_populate_recordset(null::public.spiff_line_edits, coalesce((SELECT jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'changed_at', now(), 'changed_by', p_actor, 'source', 'generate_carryover') || x) FROM jsonb_array_elements(p_audit) x), '[]'::jsonb));
  GET DIAGNOSTICS v_audit = ROW_COUNT;
  UPDATE public.spiff_runs SET date_from = p_date_from, date_to = p_date_to, totals = p_totals WHERE id = p_run_id;
  IF v_lines <> jsonb_array_length(p_lines) OR v_checks <> jsonb_array_length(p_checks) OR v_audit <> jsonb_array_length(p_audit) THEN
    RAISE EXCEPTION 'replacement insert count mismatch';
  END IF;
  RETURN jsonb_build_object('lines', v_lines, 'checks', v_checks, 'audit', v_audit, 'summary', 1);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.replace_spiff_run(uuid,int,int,jsonb,jsonb,jsonb,jsonb,date,date,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_spiff_run(uuid,int,int,jsonb,jsonb,jsonb,jsonb,date,date,uuid) TO service_role;

REVOKE ALL ON public.spiff_line_edits FROM anon;
REVOKE REFERENCES, TRIGGER, MAINTAIN ON public.spiff_line_edits FROM authenticated;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN REVOKE INSERT ON public.spiff_line_edits FROM sandbox_exec; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN REVOKE UPDATE ON public.spiff_line_edits FROM sandbox_exec; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN REVOKE DELETE ON public.spiff_line_edits FROM sandbox_exec; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN REVOKE TRUNCATE ON public.spiff_line_edits FROM sandbox_exec; END IF; END $$;
DO $$
DECLARE v_owner record;
BEGIN
  FOR v_owner IN SELECT DISTINCT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid IN ('public.log_spiff_line_edit()'::regprocedure, 'public.replace_spiff_run(uuid,int,int,jsonb,jsonb,jsonb,jsonb,date,date,uuid)'::regprocedure)
  LOOP
    IF NOT (v_owner.rolsuper OR v_owner.rolbypassrls) THEN
      EXECUTE format('CREATE POLICY %I ON public.spiff_line_edits FOR INSERT TO %I WITH CHECK (true)', 'audit_owner_insert_' || v_owner.rolname, v_owner.rolname);
    END IF;
  END LOOP;
END $$;
ALTER TABLE public.spiff_line_edits FORCE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.guard_spiff_audit_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'SPIFF audit is append-only'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guard_spiff_audit_append_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER spiff_audit_no_update_delete BEFORE UPDATE OR DELETE ON public.spiff_line_edits FOR EACH ROW EXECUTE FUNCTION public.guard_spiff_audit_append_only();
CREATE TRIGGER spiff_audit_no_truncate BEFORE TRUNCATE ON public.spiff_line_edits FOR EACH STATEMENT EXECUTE FUNCTION public.guard_spiff_audit_append_only();
REVOKE UPDATE, DELETE, TRUNCATE ON public.spiff_line_edits FROM service_role;
/* Rollback (DDL only; retains audit rows):
DROP TRIGGER IF EXISTS spiff_audit_no_update_delete ON public.spiff_line_edits;
DROP TRIGGER IF EXISTS spiff_audit_no_truncate ON public.spiff_line_edits;
DROP FUNCTION IF EXISTS public.guard_spiff_audit_append_only();
DROP FUNCTION IF EXISTS public.replace_spiff_run(uuid,int,int,jsonb,jsonb,jsonb,jsonb,date,date,uuid);
ALTER TABLE public.spiff_line_edits NO FORCE ROW LEVEL SECURITY;
-- If created for non-bypass owners, drop audit_owner_insert_<owner> policies.
GRANT SELECT ON public.spiff_line_edits TO anon;
GRANT REFERENCES, TRIGGER, MAINTAIN ON public.spiff_line_edits TO authenticated;
GRANT UPDATE, DELETE, TRUNCATE ON public.spiff_line_edits TO service_role;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.spiff_line_edits TO sandbox_exec; END IF; END $$;
*/