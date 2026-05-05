
CREATE TABLE public.p21_bridge_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  version text,
  ip text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.p21_bridge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  error text,
  agent_id uuid REFERENCES public.p21_bridge_agents(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX idx_p21_jobs_status ON public.p21_bridge_jobs(status, created_at);

ALTER TABLE public.p21_bridge_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.p21_bridge_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bridge agents admin" ON public.p21_bridge_agents
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "bridge jobs admin" ON public.p21_bridge_jobs
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
