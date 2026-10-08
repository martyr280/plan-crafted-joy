ALTER TABLE public.archiver_content_rules   ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.archiver_internal_routes ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.archiver_multi_routes    ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.archiver_learned DROP CONSTRAINT archiver_learned_source_check;
ALTER TABLE public.archiver_learned ADD CONSTRAINT archiver_learned_source_check CHECK (source IN ('auto','taught','corrected','archive','legacy','import','forgotten'));
ALTER TABLE public.archiver_messages ADD COLUMN human_team_key text;