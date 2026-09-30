CREATE TABLE public.sales_recon_aug2026 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_code text,
  cust_code text,
  customer_name text,
  aug_sales numeric,
  aug_profit numeric,
  ytd_2026 numeric,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.sales_recon_aug2026 TO authenticated;
GRANT ALL ON public.sales_recon_aug2026 TO service_role;
ALTER TABLE public.sales_recon_aug2026 ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read recon" ON public.sales_recon_aug2026 FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
COMMENT ON TABLE public.sales_recon_aug2026 IS 'VERIFICATION — Aug 2026 recon vs NDI files; drop after sign-off';