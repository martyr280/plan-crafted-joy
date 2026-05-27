
CREATE TABLE public.chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL DEFAULT 'New chat',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_conversations_user_idx ON public.chat_conversations(user_id, updated_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversations TO authenticated;
GRANT ALL ON public.chat_conversations TO service_role;
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own conversations" ON public.chat_conversations FOR SELECT TO authenticated USING (user_id = auth.uid() OR has_role(auth.uid(), 'admin'));
CREATE POLICY "users insert own conversations" ON public.chat_conversations FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "users update own conversations" ON public.chat_conversations FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "users delete own conversations" ON public.chat_conversations FOR DELETE TO authenticated USING (user_id = auth.uid() OR has_role(auth.uid(), 'admin'));

CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_idx ON public.chat_messages(conversation_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO authenticated;
GRANT ALL ON public.chat_messages TO service_role;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own messages" ON public.chat_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.chat_conversations c WHERE c.id = conversation_id AND (c.user_id = auth.uid() OR has_role(auth.uid(), 'admin'))));
CREATE POLICY "users insert own messages" ON public.chat_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.chat_conversations c WHERE c.id = conversation_id AND c.user_id = auth.uid()));

CREATE TRIGGER touch_chat_conversations_updated_at BEFORE UPDATE ON public.chat_conversations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
