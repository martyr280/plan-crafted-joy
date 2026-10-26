-- Email Archiver v4.5.3: phrase rules may look in the sender's display name (scope 'sender').
ALTER TABLE public.archiver_content_rules DROP CONSTRAINT IF EXISTS archiver_content_rules_scope_check;
ALTER TABLE public.archiver_content_rules ADD CONSTRAINT archiver_content_rules_scope_check
  CHECK (scope = ANY (ARRAY['any'::text, 'subject'::text, 'body'::text, 'attachments'::text, 'sender'::text]));
ALTER TABLE public.archiver_multi_routes DROP CONSTRAINT IF EXISTS archiver_multi_routes_scope_check;
ALTER TABLE public.archiver_multi_routes ADD CONSTRAINT archiver_multi_routes_scope_check
  CHECK (scope = ANY (ARRAY[''::text, 'any'::text, 'subject'::text, 'body'::text, 'attachments'::text, 'sender'::text]));