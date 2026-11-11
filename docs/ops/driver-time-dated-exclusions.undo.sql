-- Driver Time: undo docs/ops/driver-time-dated-exclusions.sql.
--
-- NOT APPLIED. Operator script, not a migration. Run by hand only if the
-- forward script was applied and needs to be reversed.
--
-- What it does, on app_settings key 'driver_time' only:
--   excludedDriverIds  ["58143755"]                      ->  ["58143755","55836799","53332924"]
--   excludedDrivers    the two entries the script wrote  ->  key removed
-- All three drivers are then hidden in every week again, as before.
--
-- Guards (any failure raises, and the whole transaction rolls back):
--   - the row is locked with SELECT ... FOR UPDATE;
--   - before: both keys are exactly what the forward script wrote. If anyone
--     has hidden or restored a driver since, this stops; review by hand;
--   - after: excludedDriverIds is exactly the original three ids in their
--     original order and excludedDrivers is gone;
--   - every other key in the JSON is unchanged;
--   - the app_settings row count is unchanged.

BEGIN;

DO $$
DECLARE
  before_value jsonb;
  after_value jsonb;
  rows_before bigint;
  rows_after bigint;
  expected_ids constant jsonb := '["58143755"]'::jsonb;
  expected_dated constant jsonb := '[
    {"id":"55836799","hiddenFrom":"2026-11-09","hiddenBy":null,"hiddenAt":null},
    {"id":"53332924","hiddenFrom":"2026-11-09","hiddenBy":null,"hiddenAt":null}
  ]'::jsonb;
  original_ids constant jsonb := '["58143755","55836799","53332924"]'::jsonb;
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
  IF before_value -> 'excludedDrivers' IS DISTINCT FROM expected_dated THEN
    RAISE EXCEPTION 'excludedDrivers is %, expected the two entries from the forward script; nothing changed',
      before_value -> 'excludedDrivers';
  END IF;

  UPDATE public.app_settings
  SET value = (before_value - 'excludedDrivers')
        || jsonb_build_object('excludedDriverIds', original_ids),
      updated_at = now()
  WHERE key = 'driver_time';

  SELECT value INTO after_value FROM public.app_settings WHERE key = 'driver_time';

  IF after_value -> 'excludedDriverIds' IS DISTINCT FROM original_ids THEN
    RAISE EXCEPTION 'after: excludedDriverIds is %', after_value -> 'excludedDriverIds';
  END IF;
  IF after_value ? 'excludedDrivers' THEN
    RAISE EXCEPTION 'after: excludedDrivers still present';
  END IF;
  IF (after_value - 'excludedDriverIds' - 'excludedDrivers')
     IS DISTINCT FROM (before_value - 'excludedDriverIds' - 'excludedDrivers') THEN
    RAISE EXCEPTION 'after: other driver_time keys changed';
  END IF;

  SELECT count(*) INTO rows_after FROM public.app_settings;
  IF rows_after <> rows_before THEN
    RAISE EXCEPTION 'app_settings row count changed from % to %', rows_before, rows_after;
  END IF;

  RAISE NOTICE 'driver_time: 55836799 and 53332924 are legacy hides again (every week)';
END $$;

COMMIT;
