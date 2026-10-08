-- Order Mail (Email Archiver web app), WP-OM1. New tables only; nothing existing changes.
-- Reads: admin + ops_orders (Customer Care). Writes: service role only (server functions).
-- Every table carries the RESTRICTIVE branch_manager_deny policy like all 84 existing tables.

-- Teams = the desktop customer-mapping.csv rows (+ IGNORED / UNROUTED destinations).
CREATE TABLE public.archiver_teams (
  key            text PRIMARY KEY,
  display_name   text NOT NULL,
  folder_path    text NOT NULL,                    -- relative to the agent's ARCHIVE_ROOT
  kind           text NOT NULL DEFAULT 'team' CHECK (kind IN ('team','ignored','unrouted')),
  sender_domains text[] NOT NULL DEFAULT '{}',     -- mapping domain rules (lower-case)
  keywords       text[] NOT NULL DEFAULT '{}',
  sort_order     int  NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.archiver_content_rules (
  id          text PRIMARY KEY,                    -- desktop ids kept (cr_YYYYMMDD_HHMMSS_xxxx)
  phrase      text NOT NULL CHECK (char_length(phrase) BETWEEN 3 AND 200),
  team_key    text NOT NULL REFERENCES public.archiver_teams(key) ON UPDATE CASCADE,
  scope       text NOT NULL DEFAULT 'any' CHECK (scope IN ('any','subject','body','attachments')),
  match       text NOT NULL DEFAULT 'contains' CHECK (match IN ('contains','word','regex')),
  weight      numeric(4,2) NOT NULL DEFAULT 0.94 CHECK (weight BETWEEN 0.50 AND 0.99),
  note        text NOT NULL DEFAULT '',
  hits        int  NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  source      text NOT NULL DEFAULT 'web' CHECK (source IN ('desktop_import','web')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  created_by_name text NOT NULL DEFAULT ''
);

CREATE TABLE public.archiver_internal_routes (
  address     text PRIMARY KEY CHECK (address = lower(address)),
  team_key    text NOT NULL REFERENCES public.archiver_teams(key) ON UPDATE CASCADE,
  note        text NOT NULL DEFAULT '',
  source      text NOT NULL DEFAULT 'web' CHECK (source IN ('desktop_import','web')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  created_by_name text NOT NULL DEFAULT ''
);

CREATE TABLE public.archiver_multi_routes (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('sender','domain','phrase')),
  value       text NOT NULL,
  team_keys   text[] NOT NULL CHECK (cardinality(team_keys) >= 2),
  scope       text NOT NULL DEFAULT '' CHECK (scope IN ('','any','subject','body','attachments')),
  match       text NOT NULL DEFAULT '' CHECK (match IN ('','contains','word','regex')),
  note        text NOT NULL DEFAULT '',
  hits        int  NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT 'web' CHECK (source IN ('desktop_import','web')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  created_by_name text NOT NULL DEFAULT '',
  UNIQUE (kind, value)
);

CREATE TABLE public.archiver_learned (
  bucket     text NOT NULL CHECK (bucket IN ('sender','domain')),
  key        text NOT NULL CHECK (key = lower(key)),
  team_key   text NOT NULL,                        -- no FK: desktop entries may name retired teams
  count      int  NOT NULL DEFAULT 1,
  source     text NOT NULL CHECK (source IN ('auto','taught','corrected','archive','legacy','import')),
  first_at   text NOT NULL DEFAULT '',             -- desktop ISO text kept verbatim
  last_at    text NOT NULL DEFAULT '',
  root       text NOT NULL DEFAULT '',
  run        text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, key)
);

CREATE TABLE public.archiver_mailboxes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox                 text NOT NULL,           -- e.g. rmcgaughy@ndiof.com
  folder_path             text NOT NULL,           -- e.g. Nashville orders
  folder_id               text,                    -- Graph folder id, resolved on first sweep
  delta_link              text,
  subscription_id         text,
  subscription_expires_at timestamptz,
  client_state            text,                    -- webhook shared secret (random per subscription)
  enabled                 boolean NOT NULL DEFAULT false,
  start_at                timestamptz,             -- ignore mail received before this
  last_sweep_at           timestamptz,
  last_error              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, folder_path)
);

-- One row per email seen in a watched folder. Current decision is denormalised here.
CREATE TABLE public.archiver_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id          uuid REFERENCES public.archiver_mailboxes(id) ON DELETE SET NULL,
  graph_id            text UNIQUE,                 -- immutable id
  internet_message_id text,
  ledger_key          text NOT NULL UNIQUE,        -- 'mid:<message-id lower>' | 'eid:<id>' (same as desktop)
  received_at         timestamptz NOT NULL,
  received_local      text NOT NULL,               -- America/Chicago 'yyyy-MM-ddTHH:mm:ss' (filename stamp)
  sender_address      text NOT NULL DEFAULT '',
  sender_name         text NOT NULL DEFAULT '',
  subject             text NOT NULL DEFAULT '',
  body_text           text NOT NULL DEFAULT '',    -- truncated to body_chars
  attachment_names    text[] NOT NULL DEFAULT '{}',
  web_link            text,
  storage_path        text,                        -- MIME copy in the archiver-mail bucket
  size_bytes          int,
  status              text NOT NULL DEFAULT 'new' CHECK (status IN
                        ('new','classified','queued','filed','unrouted','ignored','skipped','excluded','failed','archived')),
  excluded_reason     text,
  team_key            text,
  also_team_keys      text[] NOT NULL DEFAULT '{}',
  confidence          numeric(4,2),
  route_source        text,
  evidence            text,
  ambiguity           text,
  rule_id             text,
  stem                text,
  mode                text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','live')),
  desktop_team_key    text,                        -- shadow mode: what the desktop app did (from its ledger)
  outlook_marked_at   timestamptz,
  is_verification     boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX archiver_messages_received_idx ON public.archiver_messages (received_at DESC);
CREATE INDEX archiver_messages_status_idx   ON public.archiver_messages (status, received_at DESC);
CREATE INDEX archiver_messages_imid_idx     ON public.archiver_messages (lower(internet_message_id));

CREATE TABLE public.archiver_decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     uuid NOT NULL REFERENCES public.archiver_messages(id) ON DELETE CASCADE,
  engine_version text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('shadow','live')),
  team_key       text NOT NULL,
  also_team_keys text[] NOT NULL DEFAULT '{}',
  confidence     numeric(4,2) NOT NULL,
  route_source   text NOT NULL DEFAULT '',
  evidence       text NOT NULL DEFAULT '',
  ambiguity      text NOT NULL DEFAULT '',
  rule_id        text NOT NULL DEFAULT '',
  stem           text NOT NULL,
  destination    text NOT NULL DEFAULT '',
  decided_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX archiver_decisions_msg_idx ON public.archiver_decisions (message_id, decided_at DESC);

-- Every file write / move on O:. idempotency_key makes a retried bridge job a no-op.
CREATE TABLE public.archiver_filings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES public.archiver_messages(id) ON DELETE CASCADE,
  team_key        text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('primary','copy','refile','archive','restore')),
  rel_path        text NOT NULL,                   -- folder relative to ARCHIVE_ROOT
  file_name       text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  bridge_job_id   uuid REFERENCES public.p21_bridge_jobs(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','error','superseded')),
  sha256          text,
  bytes           int,
  written_path    text,                            -- as reported by the agent
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX archiver_filings_msg_idx ON public.archiver_filings (message_id);
CREATE INDEX archiver_filings_status_idx ON public.archiver_filings (status, created_at);

CREATE TABLE public.archiver_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES public.archiver_messages(id) ON DELETE SET NULL,
  user_id    uuid,
  user_name  text NOT NULL DEFAULT '',
  action     text NOT NULL CHECK (action IN ('wrong_team','teach','archive','restore','also_file','note',
                                             'needs_reply','reply_done','rule_add','rule_remove','learned_forget',
                                             'settings','import','cutover')),
  from_team  text,
  to_team    text,
  team_keys  text[] NOT NULL DEFAULT '{}',
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX archiver_actions_created_idx ON public.archiver_actions (created_at DESC);

CREATE TABLE public.archiver_notes (
  ledger_key  text PRIMARY KEY,
  message_id  uuid REFERENCES public.archiver_messages(id) ON DELETE SET NULL,
  needs_reply boolean NOT NULL DEFAULT false,
  done        boolean NOT NULL DEFAULT false,
  note        text NOT NULL DEFAULT '',
  subject     text NOT NULL DEFAULT '',
  sender      text NOT NULL DEFAULT '',
  team_key    text NOT NULL DEFAULT '',
  received    text NOT NULL DEFAULT '',
  by_name     text NOT NULL DEFAULT '',
  done_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Desktop processed.log + web filings: the single "already filed" record.
CREATE TABLE public.archiver_ledger (
  key         text PRIMARY KEY,                    -- mid:... | eid:...
  entry_id    text NOT NULL DEFAULT '',
  stem        text NOT NULL DEFAULT '',
  destination text NOT NULL DEFAULT '',
  filed_at    text NOT NULL DEFAULT '',            -- desktop ISO text kept verbatim
  host        text NOT NULL DEFAULT '',
  user_name   text NOT NULL DEFAULT '',
  source      text NOT NULL CHECK (source IN ('desktop','web')),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.archiver_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid REFERENCES public.archiver_mailboxes(id) ON DELETE SET NULL,
  trigger    text NOT NULL CHECK (trigger IN ('cron','webhook','manual')),
  mode       text NOT NULL CHECK (mode IN ('shadow','live')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  status     text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','skipped')),
  counts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error      text
);
CREATE INDEX archiver_runs_started_idx ON public.archiver_runs (started_at DESC);

-- RLS: read for admin + Customer Care (ops_orders); no client writes (service role bypasses RLS).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['archiver_teams','archiver_content_rules','archiver_internal_routes','archiver_multi_routes',
    'archiver_learned','archiver_mailboxes','archiver_messages','archiver_decisions','archiver_filings',
    'archiver_actions','archiver_notes','archiver_ledger','archiver_runs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY branch_manager_deny ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (SELECT private.is_branch_manager(auth.uid()))) WITH CHECK (NOT (SELECT private.is_branch_manager(auth.uid())))', t);
    EXECUTE format('CREATE POLICY "order mail read" ON public.%I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''admin''::public.app_role) OR public.has_role(auth.uid(), ''ops_orders''::public.app_role))', t);
  END LOOP;
END $$;

-- Mailbox rows hold the delta link and webhook secret: admins only.
DROP POLICY "order mail read" ON public.archiver_mailboxes;
CREATE POLICY "order mail admin read" ON public.archiver_mailboxes FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- The private 'archiver-mail' bucket (MIME copies) is created with the storage tool, not here:
-- the migration runner may not write storage.buckets.

-- Destinations that are not teams.
INSERT INTO public.archiver_teams (key, display_name, folder_path, kind, sort_order) VALUES
  ('IGNORED',  'Ignored',  'Ignored',  'ignored',  90),
  ('UNROUTED', 'Unrouted', 'Unrouted', 'unrouted', 99);
