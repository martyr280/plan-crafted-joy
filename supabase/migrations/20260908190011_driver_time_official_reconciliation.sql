-- Additive: preserve Paycom fields and every original automated event.
ALTER TABLE public.driver_time_week_overrides
  ADD COLUMN IF NOT EXISTS warehouse_actual jsonb,
  ADD COLUMN IF NOT EXISTS warehouse_actual_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.driver_time_week_overrides
  ADD CONSTRAINT warehouse_actual_valid CHECK (
    warehouse_actual IS NULL OR (
      jsonb_typeof(warehouse_actual) = 'object'
      AND warehouse_actual->>'scope' = 'weekdays'
      AND warehouse_actual->>'hub' IN ('Birmingham','Dallas','Ocala')
      AND length(warehouse_actual->>'driverName') > 0
      AND length(warehouse_actual->>'source') > 0
      AND length(warehouse_actual->>'reason') > 0
      AND (warehouse_actual->>'minutes') ~ '^[0-9]+$'
      AND (warehouse_actual->>'minutes')::integer BETWEEN 0 AND 7200
      AND extract(isodow FROM week_start) = 1
    ) IS TRUE
  );

CREATE OR REPLACE FUNCTION public.audit_driver_warehouse_actual()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.driver_id IS DISTINCT FROM NEW.driver_id OR OLD.week_start IS DISTINCT FROM NEW.week_start THEN
      RAISE EXCEPTION 'A weekly correction cannot be reassigned to a different driver or week';
    END IF;
    NEW.warehouse_actual_history := OLD.warehouse_actual_history;
  ELSE
    NEW.warehouse_actual_history := '[]'::jsonb;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.warehouse_actual IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.warehouse_actual IS DISTINCT FROM OLD.warehouse_actual) THEN
    NEW.warehouse_actual_history := NEW.warehouse_actual_history || jsonb_build_array(
      jsonb_build_object('at',now(),'actor',coalesce(auth.uid(),NEW.updated_by),
        'before',CASE WHEN TG_OP = 'UPDATE' THEN OLD.warehouse_actual ELSE NULL END,
        'after',NEW.warehouse_actual));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER driver_warehouse_actual_audit
  BEFORE INSERT OR UPDATE ON public.driver_time_week_overrides
  FOR EACH ROW EXECUTE FUNCTION public.audit_driver_warehouse_actual();

CREATE OR REPLACE FUNCTION public.preserve_driver_warehouse_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF jsonb_array_length(OLD.warehouse_actual_history) > 0 THEN
    RAISE EXCEPTION 'Clear the official value through a new revision; preserve its audit history';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER driver_warehouse_actual_preserve
  BEFORE DELETE ON public.driver_time_week_overrides
  FOR EACH ROW EXECUTE FUNCTION public.preserve_driver_warehouse_audit();

ALTER TABLE public.driver_warehouse_events ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE public.driver_warehouse_runs
  ADD COLUMN IF NOT EXISTS window_start timestamptz,
  ADD COLUMN IF NOT EXISTS window_end timestamptz;

-- Existing logistics/admin RLS policies and grants continue to govern these
-- columns. No new exposed table, definer function, or anonymous grant.
