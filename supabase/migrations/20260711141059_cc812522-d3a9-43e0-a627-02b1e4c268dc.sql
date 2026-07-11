ALTER TABLE public.spiff_run_lines
  ADD COLUMN IF NOT EXISTS first_invoice_date date,
  ADD COLUMN IF NOT EXISTS last_invoice_date date,
  ADD COLUMN IF NOT EXISTS invoice_date date;