ALTER TABLE public.sales_report_rows
  ADD COLUMN IF NOT EXISTS customer_id text,
  ADD COLUMN IF NOT EXISTS ship_to_id text,
  ADD COLUMN IF NOT EXISTS target_sales numeric,
  ADD COLUMN IF NOT EXISTS sales_rep_id text;