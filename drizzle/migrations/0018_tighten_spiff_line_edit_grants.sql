REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.spiff_line_edits FROM anon, authenticated;

-- Rollback (restores prior privileges; RLS still governs access):
-- GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.spiff_line_edits TO anon, authenticated;
