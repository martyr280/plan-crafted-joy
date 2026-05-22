-- P21 query catalog: named, parameterized read-only SELECT definitions.
-- The app resolves an entry, sends the SQL + params to the agent as a
-- `sql.select` bridge job, and the agent runs it (read-only) against P21.
-- Add/edit queries here — no agent rebuild needed.

CREATE TABLE public.p21_query_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  -- A single read-only statement: SELECT ... or WITH ... SELECT ...
  -- Do NOT include `USE <db>;` — the agent connection already targets P21.
  -- Use named parameters (@paramName); never string-concatenate values.
  sql text NOT NULL,
  -- [{ "name": "itemId", "type": "string", "required": true }, ...]
  param_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.p21_query_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "p21 catalog admin manage"
  ON public.p21_query_catalog FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "p21 catalog reporters read"
  ON public.p21_query_catalog FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'ops_reports'));

-- Seed one parameterized example so the shape is clear.
INSERT INTO public.p21_query_catalog (slug, name, description, sql, param_schema) VALUES
(
  'item-onhand-by-location',
  'Item on-hand by location',
  'Quantity on hand / allocated / available for a single item, per location.',
  'SELECT b.location_id,
          b.qty_on_hand,
          b.qty_allocated,
          (b.qty_on_hand - b.qty_allocated) AS qty_available
   FROM dbo.inv_mast a
   JOIN dbo.inv_loc b ON a.inv_mast_uid = b.inv_mast_uid
   WHERE a.item_id = @itemId
   ORDER BY b.location_id',
  '[{"name":"itemId","type":"string","required":true}]'::jsonb
);
