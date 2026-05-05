
ALTER TABLE public.report_schedules
  ADD COLUMN IF NOT EXISTS date_range text NOT NULL DEFAULT 'last_7_days',
  ADD COLUMN IF NOT EXISTS audience_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'csv',
  ADD COLUMN IF NOT EXISTS filters jsonb NOT NULL DEFAULT '{}'::jsonb;
