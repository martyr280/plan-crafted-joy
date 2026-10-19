CREATE TABLE public.spiff_line_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  line_id uuid,
  line_key text NOT NULL,
  customer_id text,
  order_no text,
  item_id text,
  invoice_date date,
  qty_ordered numeric,
  extended_price numeric,
  field text NOT NULL,
  old_value text,
  new_value text,
  changed_by uuid DEFAULT auth.uid(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'app'
);
GRANT SELECT ON public.spiff_line_edits TO authenticated;
GRANT ALL ON public.spiff_line_edits TO service_role;
ALTER TABLE public.spiff_line_edits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read SPIFF line edits" ON public.spiff_line_edits FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY branch_manager_deny ON public.spiff_line_edits AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT (SELECT private.is_branch_manager(auth.uid())))
  WITH CHECK (NOT (SELECT private.is_branch_manager(auth.uid())));
CREATE INDEX spiff_line_edits_run_changed_at_idx ON public.spiff_line_edits (run_id, changed_at);
CREATE INDEX spiff_line_edits_run_line_key_idx ON public.spiff_line_edits (run_id, line_key);

CREATE FUNCTION public.log_spiff_line_edit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  key_text text;
  field_name text;
  before_json jsonb := to_jsonb(OLD);
  after_json jsonb := to_jsonb(NEW);
BEGIN
  -- Mirrors src/lib/spiff/line-key.ts: customer|order|[oe_line_no|]item|date|qty|price.
  -- Nulls are empty; date is YYYY-MM-DD; numeric trailing fractional zeros removed.
  -- PO, description, writing rep and UUID are deliberately excluded.
  key_text := coalesce(NEW.customer_id, '') || '|' || coalesce(NEW.order_no, '') || '|' ||
    CASE WHEN coalesce(NEW.flags->>'oe_line_no', '') = '' THEN '' ELSE (NEW.flags->>'oe_line_no') || '|' END ||
    coalesce(NEW.item_id, '') || '|' || coalesce(to_char(coalesce(NEW.last_invoice_date, NEW.invoice_date), 'YYYY-MM-DD'), '') || '|' ||
    coalesce(trim_scale(NEW.qty_ordered)::text, '') || '|' || coalesce(trim_scale(NEW.extended_price)::text, '');
  FOREACH field_name IN ARRAY ARRAY['included','exclusion_reason','writing_rep','rep_parse_confidence','spiff_amount'] LOOP
    IF (after_json->field_name) IS DISTINCT FROM (before_json->field_name) THEN
      INSERT INTO public.spiff_line_edits
        (run_id, line_id, line_key, customer_id, order_no, item_id, invoice_date, qty_ordered, extended_price, field, old_value, new_value, changed_by, source)
      VALUES
        (NEW.run_id, NEW.id, key_text, NEW.customer_id, NEW.order_no, NEW.item_id,
         coalesce(NEW.last_invoice_date, NEW.invoice_date), NEW.qty_ordered, NEW.extended_price,
         field_name, before_json->>field_name, after_json->>field_name, auth.uid(),
         CASE WHEN auth.uid() IS NOT NULL THEN 'app' ELSE 'server' END);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.log_spiff_line_edit() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER spiff_run_lines_audit AFTER UPDATE ON public.spiff_run_lines
  FOR EACH ROW EXECUTE FUNCTION public.log_spiff_line_edit();

-- Rollback (manual, destroys only the new edit history):
-- DROP TRIGGER spiff_run_lines_audit ON public.spiff_run_lines;
-- DROP FUNCTION public.log_spiff_line_edit();
-- DROP TABLE public.spiff_line_edits;
