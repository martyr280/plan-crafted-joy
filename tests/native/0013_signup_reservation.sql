-- NATIVE-SQL ONLY: run in a disposable PostgreSQL cluster with migrations applied and a synthetic
-- auth.users(id uuid, email text, raw_user_meta_data jsonb) fixture + on_auth_user_created trigger.
-- NEVER run against the live project. Everything is rolled back.
BEGIN;
SELECT set_config('nelson.bm_rpc', 'on', true);
INSERT INTO public.branch_manager_invites (id, email_normalized, warehouse, status, created_by, first_claimed_at, claim_expires_at) VALUES
 ('00000000-0000-4000-a000-000000000001','expired@synthetic.test','Dallas','claimed',gen_random_uuid(), now()-interval '1 hour', now()-interval '1 minute'),
 ('00000000-0000-4000-a000-000000000002','cancelclaimed@synthetic.test','Ocala','cancelled',gen_random_uuid(), now()-interval '1 hour', NULL),
 ('00000000-0000-4000-a000-000000000003','revoked@synthetic.test','Birmingham','revoked',gen_random_uuid(), now()-interval '1 hour', NULL),
 ('00000000-0000-4000-a000-000000000004','draftonly@synthetic.test','Dallas','draft',gen_random_uuid(), NULL, NULL),
 ('00000000-0000-4000-a000-000000000005','cancelleddraft@synthetic.test','Dallas','cancelled',gen_random_uuid(), NULL, NULL);
SELECT set_config('nelson.bm_rpc', '', true);

INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
 ('00000000-0000-4000-b000-000000000001','Expired@synthetic.test','{}'),
 ('00000000-0000-4000-b000-000000000002','cancelclaimed@synthetic.test','{}'),
 ('00000000-0000-4000-b000-000000000003','revoked@synthetic.test','{}'),
 ('00000000-0000-4000-b000-000000000004','draftonly@synthetic.test','{}'),
 ('00000000-0000-4000-b000-000000000005','cancelleddraft@synthetic.test','{}'),
 ('00000000-0000-4000-b000-000000000006','unrelated@synthetic.test','{}');

DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..4 LOOP
    IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = ('00000000-0000-4000-b000-00000000000'||i)::uuid) THEN
      RAISE EXCEPTION 'FAIL: reserved identity % got a role', i; END IF;
    IF (SELECT created_user_id FROM public.branch_manager_invites WHERE id = ('00000000-0000-4000-a000-00000000000'||i)::uuid)
       IS DISTINCT FROM ('00000000-0000-4000-b000-00000000000'||i)::uuid THEN
      RAISE EXCEPTION 'FAIL: identity % not bound', i; END IF;
    IF NOT private.is_branch_manager(('00000000-0000-4000-b000-00000000000'||i)::uuid) THEN
      RAISE EXCEPTION 'FAIL: identity % not branch-bound', i; END IF;
    IF public.has_role(('00000000-0000-4000-b000-00000000000'||i)::uuid, 'ops_orders') THEN
      RAISE EXCEPTION 'FAIL: identity % has operator capability', i; END IF;
  END LOOP;
  -- zero-effect cancelled draft and unrelated email keep the normal operator default
  IF NOT public.has_role('00000000-0000-4000-b000-000000000005','ops_orders') THEN RAISE EXCEPTION 'FAIL: cancelled draft had effect'; END IF;
  IF NOT public.has_role('00000000-0000-4000-b000-000000000006','ops_orders') THEN RAISE EXCEPTION 'FAIL: unrelated signup changed'; END IF;
  -- generic role grant into a bound identity is refused
  BEGIN
    INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-4000-b000-000000000001','ops_orders');
    RAISE EXCEPTION 'FAIL: operator role added to bound identity';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS 0013 signup reservation';
END $$;

-- A second new identity for an already-bound reservation is rejected.
DO $$ BEGIN
  BEGIN
    DELETE FROM auth.users WHERE id = '00000000-0000-4000-b000-000000000003';
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('00000000-0000-4000-b000-000000000007','revoked@synthetic.test','{}');
    RAISE EXCEPTION 'FAIL: second identity accepted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS rebind rejected';
  END;
END $$;
ROLLBACK;
