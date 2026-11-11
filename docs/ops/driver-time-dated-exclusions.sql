-- Driver Time: convert two legacy roster hides to dated hides.
--
-- NOT APPLIED. This is an operator script, not a migration. Nothing in the
-- app runs it. Review, then run once by hand in the Supabase SQL editor.
-- Undo: docs/ops/driver-time-dated-exclusions.undo.sql
--
-- What it does, on app_settings key 'driver_time' only:
--   excludedDriverIds  ["58143755","55836799","53332924"]  ->  ["58143755"]
--   excludedDrivers    (absent)                            ->  55836799 and 53332924,
--                                                              hiddenFrom 2026-11-09
-- 58143755 stays a legacy hide (hidden in every week). 55836799 and 53332924
-- are hidden from the week of Monday 2026-11-09 (America/Chicago) onward, so
-- earlier weekly reports and costs include them again. hiddenBy / hiddenAt are
-- null because no app user made these entries.
--
-- Guards (any failure raises, and the whole transaction rolls back):
--   - the row is locked with SELECT ... FOR UPDATE;
--   - before: excludedDriverIds is exactly the three ids in this order, and
--     there is no excludedDrivers key;
--   - after: both keys hold exactly the expected values;
--   - every other key in the JSON is unchanged;
--   - the app_settings row count is unchanged.
-- updated_at is bumped, so any Driver Time page open during the change gets a
-- "changed since you loaded it" conflict instead of overwriting it.

BEGIN;

DO $$
DECLARE
  before_value jsonb;
  after_value jsonb;
  rows_before bigint;
  rows_after bigint;
  expected_ids constant jsonb := '["58143755","55836799","53332924"]'::jsonb;
  next_ids constant jsonb := '["58143755"]'::jsonb;
  next_dated constant jsonb := '[
    {"id":"55836799","hiddenFrom":"2026-11-09","hiddenBy":null,"hiddenAt":null},
    {"id":"53332924","hiddenFrom":"2026-11-09","hiddenBy":null,"hiddenAt":null}
  ]'::jsonb;
BEGIN
  SELECT count(*) INTO rows_before FROM public.app_settings;

  SELECT value INTO before_value
  FROM public.app_settings
  WHERE key = 'driver_time'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_time settings row not found; nothing changed';
  END IF;

  IF before_value -> 'excludedDriverIds' IS DISTINCT FROM expected_ids THEN
    RAISE EXCEPTION 'excludedDriverIds is %, expected %; nothing changed',
      before_value -> 'excludedDriverIds', expected_ids;
  END IF;
  IF before_value ? 'excludedDrivers' THEN
    RAISE EXCEPTION 'excludedDrivers already exists (%); nothing changed',
      before_value -> 'excludedDrivers';
  END IF;

  UPDATE public.app_settings
  SET value = before_value || jsonb_build_object(
        'excludedDriverIds', next_ids,
        'excludedDrivers', next_dated),
      updated_at = now()
  WHERE key = 'driver_time';

  SELECT value INTO after_value FROM public.app_settings WHERE key = 'driver_time';

  IF after_value -> 'excludedDriverIds' IS DISTINCT FROM next_ids THEN
    RAISE EXCEPTION 'after: excludedDriverIds is %', after_value -> 'excludedDriverIds';
  END IF;
  IF after_value -> 'excludedDrivers' IS DISTINCT FROM next_dated THEN
    RAISE EXCEPTION 'after: excludedDrivers is %', after_value -> 'excludedDrivers';
  END IF;
  IF (after_value - 'excludedDriverIds' - 'excludedDrivers')
     IS DISTINCT FROM (before_value - 'excludedDriverIds' - 'excludedDrivers') THEN
    RAISE EXCEPTION 'after: other driver_time keys changed';
  END IF;

  SELECT count(*) INTO rows_after FROM public.app_settings;
  IF rows_after <> rows_before THEN
    RAISE EXCEPTION 'app_settings row count changed from % to %', rows_before, rows_after;
  END IF;

  RAISE NOTICE 'driver_time: 55836799 and 53332924 now hidden from 2026-11-09; 58143755 unchanged';
END $$;

COMMIT;
