## Ask Nelson — DB-aware chat assistant

A chat assistant available to every signed-in user, with read access to the entire operational database. Persists conversations per user, defaults to a fast model, and escalates to a stronger reasoning model when the user pushes back or asks for a deeper look.

### Surfaces
1. **`/ask` page** — full chat UI in the sidebar under a new "Assistant" group, with conversation list + active conversation pane.
2. **Floating bubble** — bottom-right widget rendered from the `_app` layout, available on every authenticated page. Expands into a compact chat panel; "Open full chat" link jumps to `/ask` with the same conversation.

### Database (migration)
- `chat_conversations` — `id`, `user_id`, `title`, `created_at`, `updated_at`. RLS: user sees own; admins see all.
- `chat_messages` — `id`, `conversation_id`, `role` (`user` | `assistant` | `tool`), `content` (text), `tool_calls` (jsonb), `model`, `tokens_in`, `tokens_out`, `created_at`. RLS scoped via parent conversation.
- GRANTs to `authenticated` + `service_role`.

### Server functions (`src/lib/ask-nelson.functions.ts`)
- `listConversations` — current user's conversations, ordered by `updated_at`.
- `getConversation(id)` — messages for one conversation (auth-scoped).
- `createConversation()` — new empty conversation, returns id.
- `deleteConversation(id)`.
- `askNelson({ conversationId, message, escalate? })` — main entry; non-streaming for v1 (simpler, fits the "concise answer" goal).

### `askNelson` flow (anti-hallucination)
1. Load conversation history (last ~20 messages).
2. **Prompt improvement pass** — quick Flash call rewrites the user message into a precise question + lists which tables/filters are likely relevant. Stored internally, not shown.
3. **Tool-calling loop** with Lovable AI (`google/gemini-3-flash-preview` by default; `openai/gpt-5.4` with `reasoning.effort: "high"` when `escalate=true` or when the user message matches challenge phrases like "are you sure", "double-check", "dig deeper", "that's wrong"). Tools exposed to the model:
   - `list_tables()` — returns the whitelisted schema (tables + columns) from a hardcoded catalog so the model knows what exists.
   - `query_table({ table, select, filters, order, limit })` — server validates `table` against the whitelist, builds a parameterized Supabase query via `supabaseAdmin`, caps `limit` at 200, returns rows + `rowCount`. Read-only — no insert/update/delete tools exposed.
   - `count_table({ table, filters })` — cheap existence/count check.
   - `sample_table({ table, limit })` — small sample for the model to inspect shape.
4. **System prompt rules** (enforced every call):
   - Only answer from tool results actually returned in this turn.
   - If tools return zero rows or the answer can't be grounded, reply exactly: *"I don't know based on the data I can see."*
   - Keep responses to 1–3 short sentences unless the user asks for detail.
   - Never invent SKUs, customer names, totals, dates.
   - Cite the table(s) used in a trailing `_sources:_` line (small, muted).
5. **Escalation** — if `escalate=true` (user clicked "Dig deeper" or asked a challenge phrase), rerun with gpt-5.4 + `reasoning.effort: "high"`, allow up to 8 tool calls instead of 4, and broaden default limits.
6. Persist user message, assistant reply, and tool-call trace into `chat_messages`. Auto-title the conversation from the first user message via a one-shot Flash call.

### Table whitelist (read-only, exposed to the tools)
All current `public` tables except `user_roles` and `profiles.email` (PII trim). Includes: `orders`, `inbound_emails`, `price_list`, `inventory_snapshots`, `e2g_inventory_snapshot`, `ar_aging`, `collection_emails`, `damage_reports`, `fleet_loads`, `fleet_routes`, `design_quotes`, `design_quote_lines`, `spiff_calculations`, `spiff_rules`, `catalogs`, `catalog_items`, `website_items`, `website_crawls`, `sku_crossref`, `pricer_publications`, `activity_events`, `app_settings`, `sales_cache`, `report_runs`, `report_schedules`, `p21_bridge_jobs`, `p21_bridge_agents`.

### UI
- **`src/routes/_app.ask.tsx`** — two-pane chat: left = conversation list with "New chat", right = messages rendered with `react-markdown`, input box, "Dig deeper" button visible on the last assistant message.
- **`src/components/ask-nelson/AskNelsonBubble.tsx`** — floating button + popover panel, mounted from `src/routes/_app.tsx`. Reuses the same hooks/server fns.
- **`src/hooks/useAskNelson.ts`** — TanStack Query wrapper: `useConversations`, `useConversation(id)`, `useSendMessage` (mutation, invalidates conversation).
- Sidebar: add new "Assistant" group → `Ask Nelson` → `/ask` (icon: `Sparkles`).

### Anti-hallucination summary
- Whitelisted tool surface (model can't query arbitrary SQL).
- Tool-grounded responses only; explicit "I don't know" fallback.
- Prompt-rewrite pre-pass narrows scope before tool selection.
- Source citation per answer.
- Escalation path uses stronger reasoning + more tool budget, not more freedom to guess.

### Out of scope (v1)
- Streaming responses (can add later).
- Writes/mutations from chat.
- Cross-tenant scoping (single-tenant app today).
