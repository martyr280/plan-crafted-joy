CREATE TABLE public.usage_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('login','module_view','feature_action')),
  module text NOT NULL,
  action text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_user_created_idx ON public.usage_events (user_id, created_at DESC);
CREATE INDEX usage_events_module_created_idx ON public.usage_events (module, created_at DESC);

GRANT SELECT, INSERT ON public.usage_events TO authenticated;
GRANT ALL ON public.usage_events TO service_role;

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own usage events"
  ON public.usage_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admins can read usage events"
  ON public.usage_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.usage_events (user_id, event_type, module, action, metadata, created_at)
SELECT u.id, 'login', 'auth', NULL, '{"backfilled": true}'::jsonb, u.last_sign_in_at
FROM auth.users u
WHERE u.last_sign_in_at IS NOT NULL;
